# Wire to a flake check with the real HTTP-capable package, never a stub.
# This pinned test driver supports kvm:tcg; no /dev/kvm is required.
{ pkgs, package, module }:
pkgs.testers.runNixOSTest {
  name = "ynab-mcp";
  requiredFeatures.kvm = false;
  qemu.forceAccel = false;
  globalTimeout = 1800;
  nodes.machine = {
    imports = [ module ];
    services.ynab-mcp = {
      enable = true;
      inherit package;
      accessTokenFile = "/run/secrets/ynab-access-token";
      allowedPlanIds = [ "00000000-0000-4000-8000-000000000001" ];
    };
    virtualisation = {
      memorySize = 2048;
      cores = 2;
      restrictNetwork = true;
    };
    networking.firewall.enable = false;
    environment.systemPackages = [ pkgs.python3 pkgs.nftables pkgs.iproute2 ];
    environment.etc."ynab-mcp-test/probe.py".source = ./probe.py;
    systemd.services.ynab-test-credential = {
      description = "Generate fake test credential only at VM runtime";
      wantedBy = [ "multi-user.target" ];
      before = [ "ynab-mcp.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; UMask = "0077"; };
      script = "${pkgs.python3}/bin/python ${./create-credential.py}";
    };
    systemd.services.ynab-test-network = {
      description = "Block and count every service-user non-loopback packet";
      wantedBy = [ "multi-user.target" ];
      before = [ "ynab-mcp.service" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        uid=$(${pkgs.coreutils}/bin/id -u ynab-mcp)
        ${pkgs.nftables}/bin/nft add table inet ynab_test
        ${pkgs.nftables}/bin/nft 'add chain inet ynab_test output { type filter hook output priority -10; policy accept; }'
        ${pkgs.nftables}/bin/nft add rule inet ynab_test output meta skuid "$uid" ip daddr != 127.0.0.0/8 counter reject
        ${pkgs.nftables}/bin/nft add rule inet ynab_test output meta skuid "$uid" ip6 daddr != ::1 counter reject
      '';
    };
    systemd.services.ynab-mcp = {
      requires = [ "ynab-test-credential.service" "ynab-test-network.service" ];
      after = [ "ynab-test-credential.service" "ynab-test-network.service" ];
    };
    # The private /run directory remains writable even with ProtectSystem=strict.
    system.stateVersion = "25.11";
  };
  testScript = builtins.readFile ./test.py;
}
