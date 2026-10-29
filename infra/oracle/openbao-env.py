#!/usr/bin/env python3
"""Fetch Trevra's operator-managed secrets from Olaryn OpenBao before deployment.

Only Oracle host-side trusted execution. Credentials and downloaded data never
leave memory except the chmod-0600 Trevra runtime env and one chmod-0600
rollback file. Never print or log value, token, digest, URI query or HTTP body.
No tenant/seat provider credentials are managed here.
"""
from __future__ import annotations

import base64
import json
import http.client
import socket
import ssl
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path("/opt/trevra")
ENV = ROOT / ".env.oracle"
ROLE = ROOT / ".openbao-approle.json"
BACKUP = ROOT / ".env.oracle.pre-openbao"
BASE = "https://secrets.olaryn.com"
# The exact OCI host egress IP is permitted by OpenBao origin Nginx. Pin the
# existing GCE origin IP here (no global /etc/hosts change, no new DNS).
# TLS still authenticates the normal secrets.olaryn.com certificate hostname.
ORIGIN_IP = "34.76.184.174"
KEYS = (
    "AUTHWARD_CLIENT_SECRET", "BETTER_AUTH_SECRET",
    "TREVRA_AGENT_TOKEN_PEPPER", "TREVRA_SECRETS_KEY",
    "MARKETING_HASH_SALT", "TRACTION_ADMIN_TOKEN", "INDEXNOW_KEY",
    "NANGO_API_KEY", "NANGO_WEBHOOK_SIGNING_KEY",
    "SMTP_USERNAME", "SMTP_PASSWORD", "CLOUDFLARE_TUNNEL_TOKEN",
    "TREVRA_DB_PASSWORD", "INGEST_API_KEY", "BILLING_CLIENT_SECRET",
    "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
)
KEY_SET = frozenset(KEYS)
VALID_ENV = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")

def private_file(path: Path) -> bytes:
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & 0o077:
        raise RuntimeError("A required private runtime file is insecure")
    return path.read_bytes()

def read_env() -> tuple[bytes,dict[str,str]]:
    raw = private_file(ENV)
    if len(raw) > 256 * 1024:
        raise RuntimeError("Runtime environment exceeds size bound")
    values:dict[str,str] = {}
    for line in raw.decode("utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        m = VALID_ENV.fullmatch(line)
        if not m:
            raise RuntimeError("Unexpected runtime environment syntax")
        k,v = m.groups()
        if k in values:
            raise RuntimeError("Duplicate runtime environment entry")
        values[k] = v
    return raw,values

def api(method: str, path: str, body: dict|None=None, token: str|None=None)->dict:
    url = BASE + "/v1/" + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Accept":"application/json"}
    if data is not None:
        headers["Content-Type"]="application/json"
    if token:
        headers["X-Vault-Token"]=token
    request = urllib.request.Request(url, headers=headers, data=data, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                          _NoRedirect(), _PinnedHTTPSHandler())
    try:
        with opener.open(request, timeout=12) as response:
            if response.geturl()!=url:
                raise RuntimeError("Unexpected OpenBao URL change")
            payload=response.read(196608)
            return json.loads(payload)
    except urllib.error.HTTPError as exc:
        # Only HTTP status and the fixed caller-selected path are logged.
        raise RuntimeError("OpenBao request HTTP "+str(exc.code)+" (details concealed)") from None
    except (urllib.error.URLError,ValueError):
        raise RuntimeError("OpenBao TLS/network/JSON response failure (details concealed)") from None

class _PinnedConnection(http.client.HTTPSConnection):
    def connect(self):
        sock=socket.create_connection((ORIGIN_IP,self.port),self.timeout,
                                      self.source_address)
        self.sock=self._context.wrap_socket(sock, server_hostname=self.host)

class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self):
        super().__init__(context=ssl.create_default_context())
    def https_open(self,req):
        return self.do_open(_PinnedConnection,req,context=self._context)

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def get_reader_token()->str:
    credentials = json.loads(private_file(ROLE))
    if set(credentials)!={"role_id","secret_id","environment","mount"}:
        raise RuntimeError("Unexpected AppRole credential format")
    if credentials["environment"] != "production" or credentials["mount"]!="approle":
        raise RuntimeError("Wrong app/environment AppRole")
    if not all(isinstance(credentials[k],str) and 10 < len(credentials[k]) < 256
               for k in ("role_id","secret_id")):
        raise RuntimeError("Invalid scoped machine credentials")
    auth=api("POST","auth/approle/login",
             {"role_id":credentials["role_id"],"secret_id":credentials["secret_id"]}).get("auth") or {}
    if (auth.get("policies") != ["production-trevra-reader"]
        or not isinstance(auth.get("client_token"),str)
        or auth.get("renewable") is True and auth.get("lease_duration",0)>1800):
        raise RuntimeError("AppRole did not issue exact scoped reader policy")
    return auth["client_token"]

def read_all(values:dict[str,str])->dict[str,str]:
    token=get_reader_token()
    try:
        mapped = {k:v for k,v in values.items() if k in KEY_SET and v != ""}
        if not mapped:
            raise RuntimeError("No managed runtime keys present")
        retrieved={}
        for key in sorted(mapped):
            result=api("GET","kv/data/production/trevra/runtime/"+key,token=token)
            item=(result.get("data") or {}).get("data") or {}
            if (set(item)!={"encoding","source_kind","env_key","value_b64"}
                or item["encoding"]!="base64"
                or item["source_kind"]!="trevra-oracle-host"
                or item["env_key"]!=key):
                raise RuntimeError("Imported Trevra secret provenance mismatch")
            value=base64.b64decode(item["value_b64"],validate=True).decode("utf-8")
            if ("\n" in value or "\r" in value or not value
                or len(value)>8192 or value.startswith("<")):
                raise RuntimeError("OpenBao runtime value cannot be rendered safely")
            retrieved[key]=value
        return retrieved
    finally:
        try:
            api("POST","auth/token/revoke-self",token=token)
        except RuntimeError:
            pass

def atomic_write(path: Path, raw: bytes):
    fd,name=tempfile.mkstemp(prefix=".openbao-env-",dir=ROOT)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name,path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def run(mode:str)->None:
    original,current=read_env()
    fetched=read_all(current)
    if mode=="--check":
        if any(current[k]!=v for k,v in fetched.items()):
            raise RuntimeError("OpenBao runtime and current environment differ")
        print("PASS Trevra OpenBao authenticated exact product/environment read, "+
              str(len(fetched))+" runtime entries matched")
        return
    if mode=="--apply":
        new_lines=[]
        for line in original.decode("utf-8").splitlines(keepends=True):
            m=VALID_ENV.fullmatch(line.rstrip("\r\n"))
            if m and m.group(1) in fetched:
                new_lines.append(m.group(1)+"="+fetched[m.group(1)]+"\n")
            else:
                new_lines.append(line)
        changed="".join(new_lines).encode("utf-8")
        if not BACKUP.exists():
            # Preserve a rollback copy before any first OpenBao-controlled write.
            flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
            fd=os.open(BACKUP,flags,0o600)
            with os.fdopen(fd,"wb") as out:
                out.write(original)
                out.flush()
                os.fsync(out.fileno())
        else:
            private_file(BACKUP)
        atomic_write(ENV,changed)
        print("PASS Trevra runtime secret values refreshed from OpenBao ("+
              str(len(fetched))+" keys); protected original rollback copy retained")
    else:
        raise RuntimeError("Use --check or --apply")

if __name__=="__main__":
    if len(sys.argv)!=2 or sys.argv[1] not in ("--check","--apply"):
        raise SystemExit("Usage: openbao-env.py --check | --apply")
    try:
        run(sys.argv[1])
    except Exception:
        print("BLOCK Trevra OpenBao source qualification failed; original service retained",
              file=sys.stderr)
        raise SystemExit(2) from None
