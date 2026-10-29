#!/usr/bin/env python3
"""Automatically rotate a host's own restricted OpenBao AppRole SecretID.

One existing AppRole is both the short-lived scoped KV reader and a capability
to mint/retire SecretIDs for *only that same role*. No root token, GPG material,
human account, Docker restart, production DB write or other-app access.
The replacement must authenticate and read the same protected host values
BEFORE being installed. Old ID is revoked only AFTER a verified atomic swap.
"""
from __future__ import annotations

import base64
from datetime import datetime,timezone
import re
import time
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

SPECS={
    "trevra":("/opt/trevra/openbao-env.py","/opt/trevra/.openbao-approle.json",
             "production-trevra-reader","/opt/trevra"),
    "lemoncrow":("/opt/lemoncrow-hosted/openbao-fetch.py",
                 "/opt/lemoncrow-hosted/.openbao-approle.json",
                 "production-lemoncrow-reader","/opt/lemoncrow-hosted"),
}
# OpenBao auth-mount max TTL can cap 90-day role config to 32 days.
ROTATE_BEFORE_S=10*24*3600
MIN_NEW_TTL_S=14*24*3600

def load_app(name:str):
    if name not in SPECS:raise RuntimeError("Unsupported fixed OpenBao app")
    script,role,policy,root=SPECS[name]
    spec=importlib.util.spec_from_file_location("olaryn_approle_runtime_"+name,script)
    if not spec or not spec.loader:raise RuntimeError("Missing trusted runtime reader")
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod,Path(role),policy,Path(root)

def protected(path:Path)->bytes:
    s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_mode&0o077 or s.st_uid!=os.geteuid():
        raise RuntimeError("Machine identity not protected by the owner")
    raw=path.read_bytes()
    if len(raw)>8192 or len(raw)<70:raise RuntimeError("Unexpected machine identity bytes")
    return raw

def credentials(path:Path)->dict:
    value=json.loads(protected(path))
    if (set(value)!={"role_id","secret_id","environment","mount"}
        or value["environment"]!="production" or value["mount"]!="approle"
        or not all(isinstance(value[k],str) and 20<len(value[k])<=256
                   for k in ("role_id","secret_id"))):
        raise RuntimeError("Unexpected production AppRole identity")
    return value

def call(mod,app,method,path,body=None,token=None):
    return (mod.api(method,path,body,token=token) if app=="trevra"
            else mod.vault(method,path,body,token=token))

def login(mod,app,creds,policy):
    result=call(mod,app,"POST","auth/approle/login",{
        "role_id":creds["role_id"],"secret_id":creds["secret_id"]})
    auth=result.get("auth") or {}
    if (auth.get("policies")!=[policy]
        or not isinstance(auth.get("client_token"),str)
        or len(auth["client_token"])<20):
        raise RuntimeError("Restricted policy mismatch during machine login")
    return auth["client_token"]

def verify_host_values(mod,app,token):
    if app=="trevra":
        _,values=mod.read_env()
        names=sorted(k for k,v in values.items() if k in mod.KEY_SET and v)
        if len(names)<10:raise RuntimeError("Unexpected live Trevra credential inventory")
        for name in names:
            result=call(mod,app,"GET","kv/data/production/trevra/runtime/"+name,token=token)
            data=((result.get("data") or {}).get("data") or {})
            if (set(data)!={"encoding","source_kind","env_key","value_b64"}
                or data["encoding"]!="base64"
                or data["source_kind"]!="trevra-oracle-host"
                or data["env_key"]!=name):
                raise RuntimeError("Trevra KV metadata mismatch")
            decoded=base64.b64decode(data["value_b64"],validate=True).decode("utf-8")
            if decoded!=values[name]:raise RuntimeError("Trevra runtime value drift")
    elif app=="lemoncrow":
        originals=mod.source_files()
        if set(originals)!=set(mod.FILES):raise RuntimeError("LemonCrow inventory mismatch")
        for name in mod.FILES:
            result=call(mod,app,"GET","kv/data/production/lemoncrow/hosted/"+name,token=token)
            data=((result.get("data") or {}).get("data") or {})
            if (set(data)!={"encoding","source_kind","filename","value_b64"}
                or data["encoding"]!="base64"
                or data["source_kind"]!="lemoncrow-shared-vm"
                or data["filename"]!=name):
                raise RuntimeError("LemonCrow KV metadata mismatch")
            if base64.b64decode(data["value_b64"],validate=True)!=originals[name]:
                raise RuntimeError("LemonCrow runtime value drift")

def atomic_credentials(path:Path,value:dict):
    original=protected(path)
    mode=stat.S_IMODE(path.stat().st_mode)
    raw=json.dumps(value,separators=(",",":")).encode()
    fd,tmp=tempfile.mkstemp(prefix=".approle-renew-",dir=path.parent)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,"wb") as f:
            f.write(raw);f.flush();os.fsync(f.fileno())
        if protected(path)!=original:raise RuntimeError("Machine credentials changed concurrently")
        os.replace(tmp,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def rotate(app:str,mode:str):
    mod,role,policy,root=load_app(app)
    # Do not leave even the lock world-readable; permit only dedicated
    # host owner (ubuntu on OCI and root on shared GCE).
    lockpath=root/".openbao-rotation.lock"
    fd=os.open(lockpath,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077:
            raise RuntimeError("Unsafe OpenBao rotation lock")
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        old=credentials(role)
        old_token=login(mod,app,old,policy)
        try:
            prefix="auth/approle/role/"+policy+"/secret-id"
            lookup=call(mod,app,"POST",prefix+"/lookup",{"secret_id":old["secret_id"]},token=old_token)
            metadata=lookup.get("data") or {}
            configured_ttl=metadata.get("secret_id_ttl")
            expiry=metadata.get("expiration_time")
            accessor=metadata.get("secret_id_accessor")
            if (not isinstance(configured_ttl,int)
                or not MIN_NEW_TTL_S<=configured_ttl<=90*24*3600
                or not isinstance(expiry,str)
                or not isinstance(accessor,str) or len(accessor)<12):
                raise RuntimeError("Current AppRole TTL or expiry metadata untrusted")
            # OpenBao secret-id/lookup reports expiration_time, not a remaining
            # ttl field. It can contain nanosecond precision (9 digits).
            iso=expiry.replace("Z","+00:00")
            iso=re.sub(r"(\.\d{6})\d+(?=[+-]\d{2}:\d{2}$)",r"\1",iso)
            timestamp=datetime.fromisoformat(iso)
            if timestamp.tzinfo is None:raise RuntimeError("Unzoned SecretID expiry")
            remaining=int(timestamp.timestamp()-time.time())
            if not 0<remaining<=configured_ttl+300:
                raise RuntimeError("Current AppRole has expired or invalid expiry")
            verify_host_values(mod,app,old_token)
            if mode=="--check":
                print("PASS",app,"restricted AppRole, host-value proof, days remaining",remaining//86400)
                return
            if remaining>ROTATE_BEFORE_S:
                print("PASS",app,"SecretID healthy; automatic rotation not due, remaining days",remaining//86400)
                return
            # Issue replacement only after proving source, TTL, owner and policy.
            issued=call(mod,app,"POST",prefix,{},token=old_token).get("data") or {}
            new_id=issued.get("secret_id")
            new_ttl=issued.get("secret_id_ttl")
            if (not isinstance(new_id,str) or len(new_id)<20
                or new_id==old["secret_id"] or not isinstance(new_ttl,int)
                or new_ttl<MIN_NEW_TTL_S):
                raise RuntimeError("New AppRole SecretID is invalid or too short-lived")
            candidate=dict(old,secret_id=new_id)
            candidate_token=login(mod,app,candidate,policy)
            try:verify_host_values(mod,app,candidate_token)
            finally:
                try:call(mod,app,"POST","auth/token/revoke-self",token=candidate_token)
                except Exception:pass
            # Only now move new credential into the protected current file.
            atomic_credentials(role,candidate)
            # A reread AND fresh authenticated lookup protects against write
            # corruption / deployment races. Old remains valid until this pass.
            confirmed=credentials(role)
            if confirmed!=candidate:raise RuntimeError("Committed identity mismatch")
            fresh=login(mod,app,confirmed,policy)
            try:verify_host_values(mod,app,fresh)
            finally:
                try:call(mod,app,"POST","auth/token/revoke-self",token=fresh)
                except Exception:pass
            # Retire the old role credential. Do not revert new after commit.
            call(mod,app,"POST",prefix+"/destroy",{"secret_id":old["secret_id"]},token=old_token)
            print("PASS",app,"AppRole SecretID replaced, validated and old ID retired")
        finally:
            try:call(mod,app,"POST","auth/token/revoke-self",token=old_token)
            except Exception:pass
    finally:
        os.close(fd)

if __name__=="__main__":
    if len(sys.argv)!=3 or sys.argv[1] not in SPECS or sys.argv[2] not in ("--check","--rotate-if-due"):
        raise SystemExit("Usage: rotate-app-approle.py <trevra|lemoncrow> <--check|--rotate-if-due>")
    try:rotate(sys.argv[1],sys.argv[2])
    except Exception:
        print("BLOCK "+sys.argv[1]+" machine identity rotation: host source or role not qualified",file=sys.stderr)
        raise SystemExit(2) from None
