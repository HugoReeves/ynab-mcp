"""Guest-only checks. No upstream request, real token, or .env file."""
import json
import pwd
import stat
import subprocess
import urllib.request
from pathlib import Path


def command(*args):
    return subprocess.check_output(args)


account = pwd.getpwnam("ynab-mcp")
source = Path("/run/secrets/ynab-access-token")
copy = Path("/run/ynab-mcp/access-token")
secret = source.read_bytes().strip()
assert secret and copy.read_bytes().strip() == secret
assert source.stat().st_uid == 0
assert stat.S_IMODE(source.stat().st_mode) == 0o600
assert copy.stat().st_uid == account.pw_uid
assert copy.stat().st_gid == account.pw_gid
assert stat.S_IMODE(copy.stat().st_mode) == 0o400
assert stat.S_IMODE(copy.parent.stat().st_mode) == 0o700
assert copy.parent.stat().st_uid == account.pw_uid
pid = command("systemctl", "show", "ynab-mcp", "-p", "MainPID", "--value").strip().decode()
environment = Path(f"/proc/{pid}/environ").read_bytes()
assert b"YNAB_ACCESS_TOKEN_FILE=/run/ynab-mcp/access-token" in environment.split(b"\0")
assert not any(v.startswith(b"YNAB_ACCESS_TOKEN=") for v in environment.split(b"\0"))
for output in (
    environment,
    Path(f"/proc/{pid}/cmdline").read_bytes(),
    command("systemctl", "cat", "ynab-mcp"),
    command("systemctl", "show", "ynab-mcp"),
    command("journalctl", "-b", "--no-pager"),
):
    assert secret not in output, "Credential leaked"
# Test the copied token from the service identity, not only from root.
subprocess.run(["runuser", "-u", "ynab-mcp", "--", "test", "-r", str(copy)], check=True)

headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
request_id = 0
# Explicitly ignore proxy environment variables.
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def rpc(method, params=None, notification=False):
    global request_id
    request_id += 1
    body = {"jsonrpc": "2.0", "method": method}
    if not notification:
        body["id"] = request_id
    if params is not None:
        body["params"] = params
    request = urllib.request.Request("http://127.0.0.1:3000/mcp", json.dumps(body).encode(), headers)
    with http.open(request, timeout=10) as response:
        if response.headers.get("Mcp-Session-Id"):
            headers["Mcp-Session-Id"] = response.headers["Mcp-Session-Id"]
        data = response.read().decode()
        if notification:
            assert response.status in (200, 202, 204)
            return None
        if response.headers.get_content_type() == "text/event-stream":
            messages = [json.loads(line[5:].strip()) for line in data.splitlines() if line.startswith("data:")]
            reply = next(message for message in messages if message.get("id") == request_id)
        else:
            reply = json.loads(data)
        assert "error" not in reply, reply
        return reply["result"]


initialized = rpc("initialize", {
    "protocolVersion": "2025-11-25", "capabilities": {},
    "clientInfo": {"name": "nixos-test", "version": "1"},
})
headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
rpc("notifications/initialized", notification=True)
tools = rpc("tools/list")["tools"]
assert len(tools) == 15, [tool["name"] for tool in tools]
assert all(tool["annotations"]["readOnlyHint"] for tool in tools)
assert "ynab_list_accounts" in {tool["name"] for tool in tools}
for name, arguments in (
    ("ynab_create_transactions", {}),
    ("ynab_delete_transaction", {}),
    ("ynab_list_accounts", {"plan_id": "00000000-0000-4000-8000-000000000002"}),
):
    result = rpc("tools/call", {"name": name, "arguments": arguments})
    assert result["isError"] is True, result
    error = result["structuredContent"]["error"]
    assert error["code"] == "permission_denied" and error["outcome"] == "not_applied", result
