# No production package is needed for module evaluation. This executable is
# deliberately only a fixture; the VM test always takes the real package.
{ pkgs, module }:
let
  inherit (pkgs) lib;
  fixture = pkgs.writeShellScriptBin "ynab-mcp" "exit 1";
  id = "00000000-0000-4000-8000-000000000001";
  evaluate = service: (import (pkgs.path + "/nixos/lib/eval-config.nix") {
    inherit pkgs;
    system = pkgs.stdenv.hostPlatform.system;
    modules = [ module {
      system.stateVersion = "25.11";
      boot.loader.grub.enable = false;
      fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
      services.ynab-mcp = { package = fixture; } // service;
    } ];
  }).config;
  valid = {
    enable = true;
    accessTokenFile = "/run/secrets/ynab-token";
    allowedPlanIds = [ id ];
  };
  cfg = evaluate valid;
  service = cfg.systemd.services.ynab-mcp;
  unit = service.serviceConfig;
  assertionsPass = c: lib.all (a: a.assertion) c.assertions;
  evaluates = value: (builtins.tryEval (builtins.deepSeq value true)).success;
  rejects = attrs: !(assertionsPass (evaluate (valid // attrs)));
  checks = {
    disabled = assertionsPass (evaluate { }) && !(evaluate { }).systemd.services ? ynab-mcp;
    defaults = cfg.services.ynab-mcp.host == "127.0.0.1"
      && cfg.services.ynab-mcp.port == 3000
      && cfg.services.ynab-mcp.readOnly
      && cfg.services.ynab-mcp.toolProfile == "core";
    valid = assertionsPass cfg;
    emptyAllowlist = rejects { allowedPlanIds = [ ]; };
    invalidUuid = rejects { allowedPlanIds = [ "not-a-uuid" ]; };
    emptyUuid = rejects { allowedPlanIds = [ "" ]; };
    missingCredential = rejects { accessTokenFile = null; };
    emptyCredential = rejects { accessTokenFile = ""; };
    relativeCredential = rejects { accessTokenFile = "secrets/token"; };
    storeCredential = rejects { accessTokenFile = "/nix/store/secret/token"; };
    storeRoot = rejects { accessTokenFile = "/nix/store"; };
    traversalCredential = rejects { accessTokenFile = "/run/../nix/store/token"; };
    doubleSlashCredential = rejects { accessTokenFile = "//nix/store/token"; };
    specifierCredential = rejects { accessTokenFile = "/run/%d/token"; };
    multiplePlans = (evaluate (valid // { allowedPlanIds = [ id id ]; })).systemd.services.ynab-mcp.environment.YNAB_ALLOWED_PLAN_IDS == "${id},${id}";
    newlineCredential = rejects { accessTokenFile = "/run/token\nother"; };
    pathNotString = !(evaluates (evaluate { accessTokenFile = ./evaluation.nix; }).services.ynab-mcp.accessTokenFile);
    publicListener = !(evaluates (evaluate (valid // { host = "0.0.0.0"; })).services.ynab-mcp.host);
    unknownProfile = !(evaluates (evaluate (valid // { toolProfile = "all"; })).services.ynab-mcp.toolProfile);
    invalidPort = !(evaluates (evaluate (valid // { port = 0; })).services.ynab-mcp.port);
    oversizedPort = !(evaluates (evaluate (valid // { port = 65536; })).services.ynab-mcp.port);
    ipv6 = assertionsPass (evaluate (valid // { host = "::1"; }));
    overrides = let c = evaluate (valid // {
      package = pkgs.hello; host = "::1"; port = 4321;
      readOnly = false; toolProfile = "extended";
    }); in c.systemd.services.ynab-mcp.serviceConfig.ExecStart == "${lib.getExe pkgs.hello} --transport http"
      && c.systemd.services.ynab-mcp.environment.YNAB_HOST == "::1"
      && c.systemd.services.ynab-mcp.environment.YNAB_PORT == "4321"
      && c.systemd.services.ynab-mcp.environment.YNAB_READ_ONLY == "false"
      && c.systemd.services.ynab-mcp.environment.YNAB_TOOL_PROFILE == "extended";
    launch = unit.ExecStart == "${lib.getExe fixture} --transport http"
      && service.wantedBy == [ "multi-user.target" ]
      && unit.Restart == "on-failure";
    identity = cfg.users.users.ynab-mcp.isSystemUser
      && cfg.users.users.ynab-mcp.group == "ynab-mcp"
      && unit.User == "ynab-mcp" && unit.Group == "ynab-mcp";
    credential = unit.LoadCredential == "ynab-access-token:/run/secrets/ynab-token"
      && unit.ExecStartPre == "${pkgs.coreutils}/bin/install -m0400 -T %d/ynab-access-token /run/ynab-mcp/access-token"
      && unit.RuntimeDirectory == "ynab-mcp"
      && unit.RuntimeDirectoryMode == "0700"
      && unit.RuntimeDirectoryPreserve == "no"
      && unit.UMask == "0077"
      && service.environment.YNAB_ACCESS_TOKEN_FILE == "/run/ynab-mcp/access-token"
      && !(service.environment ? YNAB_ACCESS_TOKEN);
    policy = service.environment.YNAB_ALLOWED_PLAN_IDS == id
      && service.environment.YNAB_READ_ONLY == "true"
      && service.environment.YNAB_TOOL_PROFILE == "core"
      && service.environment.YNAB_ALLOW_IMPORTS == "false"
      && service.environment.YNAB_ALLOW_DELETES == "false"
      && service.environment.YNAB_ALLOW_RECONCILED_CHANGES == "false";
    hardening = unit.ProtectSystem == "strict" && unit.ProtectHome
      && unit.PrivateTmp && unit.PrivateDevices && unit.NoNewPrivileges
      && unit.CapabilityBoundingSet == "" && unit.AmbientCapabilities == ""
      && unit.RestrictAddressFamilies == [ "AF_UNIX" "AF_INET" "AF_INET6" ]
      && unit.ProtectKernelTunables && unit.ProtectKernelModules
      && unit.ProtectKernelLogs && unit.ProtectControlGroups
      && !(unit.MemoryDenyWriteExecute or false);
    limits = unit.MemoryMax == "512M" && unit.TasksMax == 64;
    noFirewall = cfg.networking.firewall.allowedTCPPorts == [ ];
  };
  failures = lib.attrNames (lib.filterAttrs (_: success: !success) checks);
in
assert lib.assertMsg (failures == [ ]) "ynab-mcp module checks failed: ${lib.concatStringsSep ", " failures}";
pkgs.runCommand "ynab-mcp-module-evaluation" { passthru = { inherit checks; }; } ''
  touch "$out"
''
