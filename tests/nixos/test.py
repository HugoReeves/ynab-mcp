import json

start_all()
machine.wait_for_unit("ynab-test-credential.service")
machine.wait_for_unit("ynab-test-network.service")
machine.wait_for_unit("ynab-mcp.service")
machine.wait_for_open_port(3000, timeout=120)

with subtest("positive HTTP startup, discovery, and fail-closed policy"):
    machine.succeed("python3 /etc/ynab-mcp-test/probe.py")
    rules = json.loads(machine.succeed("nft -j list chain inet ynab_test output"))
    counters = [expr["counter"]["packets"] for item in rules["nftables"]
                if "rule" in item for expr in item["rule"]["expr"] if "counter" in expr]
    assert len(counters) == 2 and counters == [0, 0], counters

with subtest("unit limits, private filesystem, and localhost listener"):
    assert machine.succeed("systemctl show ynab-mcp -p MemoryMax --value").strip() == "536870912"
    assert machine.succeed("systemctl show ynab-mcp -p TasksMax --value").strip() == "64"
    assert machine.succeed("systemctl show ynab-mcp -p User --value").strip() == "ynab-mcp"
    assert machine.succeed("systemctl show ynab-mcp -p Restart --value").strip() == "on-failure"
    assert machine.succeed("systemctl show ynab-mcp -p UMask --value").strip() == "0077"
    machine.succeed("systemctl is-enabled ynab-mcp")
    pid = machine.succeed("systemctl show ynab-mcp -p MainPID --value").strip()
    machine.succeed("mkdir -p /home/ynab-test-home; mknod /dev/ynab-test-device c 1 3")
    machine.fail(f"nsenter -t {pid} -m -- touch /etc/ynab-protected-test")
    machine.fail(f"nsenter -t {pid} -m -- ls /home/ynab-test-home")
    machine.fail(f"nsenter -t {pid} -m -- test -e /dev/ynab-test-device")
    cgroup = machine.succeed("systemctl show ynab-mcp -p ControlGroup --value").strip()
    assert machine.succeed(f"cat /sys/fs/cgroup{cgroup}/memory.max").strip() == "536870912"
    assert machine.succeed(f"cat /sys/fs/cgroup{cgroup}/pids.max").strip() == "64"
    machine.succeed(f"nsenter -t {pid} -m -- touch /tmp/ynab-private-test")
    machine.fail("test -e /tmp/ynab-private-test")
    listeners = machine.succeed("ss -H -ltn 'sport = :3000'")
    assert "127.0.0.1:3000" in listeners, listeners
    assert "0.0.0.0:3000" not in listeners and "[::]:3000" not in listeners, listeners
    uid = machine.succeed("id -u ynab-mcp").strip()
    machine.succeed(f"test $(stat -c %u /proc/{pid}) = {uid}")
    machine.succeed(f"grep -q '^NoNewPrivs:.*1' /proc/{pid}/status")
    machine.succeed(f"grep -q '^CapEff:.*0000000000000000' /proc/{pid}/status")

with subtest("restart after process failure and secure credential recopy"):
    old_pid = machine.succeed("systemctl show ynab-mcp -p MainPID --value").strip()
    machine.succeed("systemctl kill --signal=SIGKILL --kill-whom=main ynab-mcp")
    machine.wait_until_succeeds(
        f"pid=$(systemctl show ynab-mcp -p MainPID --value); test $pid -gt 0 && test $pid != {old_pid}"
    )
    machine.wait_for_open_port(3000)
    machine.succeed("python3 /etc/ynab-mcp-test/probe.py")

with subtest("runtime cleanup and missing credential fail closed"):
    machine.succeed("systemctl stop ynab-mcp")
    machine.fail("test -e /run/ynab-mcp")
    machine.succeed("mv /run/secrets/ynab-access-token /run/secrets/temporarily-missing")
    machine.fail("systemctl start ynab-mcp")
    machine.fail("ss -H -ltn 'sport = :3000' | grep -q .")
    machine.succeed("systemctl stop ynab-mcp; mv /run/secrets/temporarily-missing /run/secrets/ynab-access-token")
    machine.succeed("systemctl reset-failed ynab-mcp; systemctl start ynab-mcp")
    machine.wait_for_open_port(3000)
    machine.succeed("python3 /etc/ynab-mcp-test/probe.py")
