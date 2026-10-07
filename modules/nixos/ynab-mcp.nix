{ config, lib, pkgs, ... }:
let
  cfg = config.services.ynab-mcp;
  uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  source = cfg.accessTokenFile;
  safeSource = source != null
    && lib.hasPrefix "/" source
    && source != "/nix/store"
    && !(lib.hasPrefix "/nix/store/" source)
    && !(lib.hasInfix "\n" source) && !(lib.hasInfix "\r" source)
    && !(lib.hasInfix "//" source) && !(lib.hasInfix "%" source)
    && lib.all (part: part != "." && part != "..") (lib.splitString "/" source);
in
{
  options.services.ynab-mcp = {
    enable = lib.mkEnableOption "the loopback-only YNAB MCP HTTP service";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../../pkgs/ynab-mcp { };
      defaultText = lib.literalExpression "pkgs.callPackage ../../pkgs/ynab-mcp { }";
      description = "YNAB MCP package. The flake module supplies its pinned package by default.";
    };
    host = lib.mkOption {
      type = lib.types.enum [ "127.0.0.1" "::1" ];
      default = "127.0.0.1";
      description = "Loopback listen address. The /mcp endpoint has no built-in authentication.";
    };
    port = lib.mkOption {
      type = lib.types.ints.between 1 65535;
      default = 3000;
      description = "HTTP listen port. This module does not open the firewall.";
    };
    accessTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/ynab-access-token";
      description = ''
        Absolute runtime path to the access token, outside /nix/store.
        Supply a string, not a Nix path. The module never reads its contents
        during evaluation. Systemd loads it as a credential, then copies it
        to a service-owned file with mode 0400.
      '';
    };
    allowedPlanIds = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "00000000-0000-4000-8000-000000000001" ];
      description = "Nonempty UUID allowlist required when enabled. An empty list never grants unrestricted access.";
    };
    readOnly = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Expose only read tools. Imports, deletes, and reconciled changes remain disabled.";
    };
    toolProfile = lib.mkOption {
      type = lib.types.enum [ "core" "extended" ];
      default = "core";
      description = "Tool discovery profile, subject to the read-only policy.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.allowedPlanIds != [ ]
          && lib.all (id: builtins.match uuid id != null) cfg.allowedPlanIds;
        message = "services.ynab-mcp.allowedPlanIds must contain at least one UUID and only UUIDs.";
      }
      {
        assertion = safeSource;
        message = "services.ynab-mcp.accessTokenFile must be an absolute string outside /nix/store, without dot segments or newlines.";
      }
    ];

    users.groups.ynab-mcp = { };
    users.users.ynab-mcp = {
      isSystemUser = true;
      group = "ynab-mcp";
    };

    systemd.services.ynab-mcp = {
      description = "YNAB MCP loopback HTTP service";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        YNAB_HOST = cfg.host;
        YNAB_PORT = toString cfg.port;
        YNAB_ACCESS_TOKEN_FILE = "/run/ynab-mcp/access-token";
        YNAB_ALLOWED_PLAN_IDS = lib.concatStringsSep "," cfg.allowedPlanIds;
        YNAB_READ_ONLY = lib.boolToString cfg.readOnly;
        YNAB_TOOL_PROFILE = cfg.toolProfile;
        YNAB_ALLOW_IMPORTS = "false";
        YNAB_ALLOW_DELETES = "false";
        YNAB_ALLOW_RECONCILED_CHANGES = "false";
      };
      serviceConfig = {
        Type = "simple";
        User = "ynab-mcp";
        Group = "ynab-mcp";
        ExecStart = "${lib.getExe cfg.package} --transport http";
        # systemd 261 may expose a root-owned credential via an ACL. Preserve
        # the application's strict owner/mode checks with a service-user copy.
        LoadCredential = "ynab-access-token:${if source == null then "" else source}";
        ExecStartPre = "${pkgs.coreutils}/bin/install -m0400 -T %d/ynab-access-token /run/ynab-mcp/access-token";
        RuntimeDirectory = "ynab-mcp";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "no";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = "5s";
        MemoryMax = "512M";
        TasksMax = 64;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        # Do not enable MemoryDenyWriteExecute: Node/V8 requires a JIT.
      };
    };
  };
}
