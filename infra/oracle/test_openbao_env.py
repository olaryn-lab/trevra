"""Trevra production OpenBao runtime envelope and fail-closed regression tests."""
from pathlib import Path
import base64
import importlib.util
import os
import stat
import tempfile
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).with_name("openbao-env.py")
spec=importlib.util.spec_from_file_location("trevra_openbao_env",SOURCE)
assert spec and spec.loader
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class HostedSecretSourceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.env=self.root/".env.oracle"
        self.role=self.root/".openbao-approle.json"
        self.backup=self.root/".env.oracle.pre-openbao"
        self.env.write_text("NANGO_API_KEY=old-key\nSMTP_PASSWORD=old-password\nPUBLIC_SITE_URL=https://usetrevra.com\n")
        self.env.chmod(0o600)
        self.patcher=patch.multiple(mod,ROOT=self.root,ENV=self.env,ROLE=self.role,BACKUP=self.backup)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def fake_reader(self,method,path,body=None,token=None):
        if method=="POST" and path=="auth/token/revoke-self":
            return {}
        key=path.rsplit("/",1)[-1]
        values={"NANGO_API_KEY":"new-key","SMTP_PASSWORD":"old-password"}
        if method=="GET" and key in values and path.startswith("kv/data/production/trevra/runtime/"):
            value=values[key]
            return {"data":{"data":{"encoding":"base64","source_kind":"trevra-oracle-host",
                     "env_key":key,"value_b64":base64.b64encode(value.encode()).decode()}}}
        raise RuntimeError("untrusted path")

    def test_atomic_secret_refresh_and_backup_are_mode_0600(self):
        old=self.env.read_bytes()
        with patch.object(mod,"get_reader_token",return_value="synthetic-only"),patch.object(mod,"api",side_effect=self.fake_reader):
            with self.assertRaises(RuntimeError):
                mod.run("--check")
            mod.run("--apply")
            mod.run("--check") 
        self.assertEqual(self.backup.read_bytes(),old)
        self.assertIn(b"NANGO_API_KEY=new-key",self.env.read_bytes())
        self.assertIn(b"PUBLIC_SITE_URL=https://usetrevra.com",self.env.read_bytes())
        self.assertEqual(stat.S_IMODE(self.env.stat().st_mode),0o600)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode),0o600)

    def test_offline_or_invalid_envelope_cannot_modify_runtime(self):
        old=self.env.read_bytes()
        with patch.object(mod,"get_reader_token",side_effect=RuntimeError("offline")):
            with self.assertRaises(RuntimeError):
                mod.run("--apply")
        self.assertEqual(self.env.read_bytes(),old)
        self.assertFalse(self.backup.exists())
        def bad_reader(method,path,body=None,token=None):
            response=self.fake_reader(method,path,body,token)
            if method=="GET":
                response["data"]["data"]["source_kind"]="wrong-source"
            return response
        with patch.object(mod,"get_reader_token",return_value="synthetic-only"),patch.object(mod,"api",side_effect=bad_reader):
            with self.assertRaises(RuntimeError):
                mod.run("--apply")
        self.assertEqual(self.env.read_bytes(),old)

    def test_every_oracle_deployer_blocks_when_enabled_vault_fetch_fails(self):
        root=Path(__file__).parent
        for filename in ("deploy.sh","deploy-micro.sh","deploy-single-micro.sh"):
            source=(root/filename).read_text()
            self.assertIn(".openbao-enabled",source,filename)
            self.assertIn("openbao-env.py --apply",source,filename)
            self.assertNotIn("|| true",source.split("openbao-env.py --apply")[0][-120:])

    def test_duplicate_or_world_readable_env_rejected(self):
        self.env.write_text("NANGO_API_KEY=a\nNANGO_API_KEY=b\n")
        with self.assertRaises(RuntimeError):
            mod.read_env()
        self.env.chmod(0o644)
        with self.assertRaises(RuntimeError):
            mod.read_env()

if __name__=="__main__":
    unittest.main()
