"""Generate a fake, private credential at VM runtime, not Nix evaluation."""
import os
import secrets
from pathlib import Path

os.umask(0o077)
directory = Path("/run/secrets")
directory.mkdir(mode=0o700, exist_ok=True)
path = directory / "ynab-access-token"
with path.open("x") as credential:
    credential.write("vm-only-" + secrets.token_hex(32) + "\n")
path.chmod(0o600)
