{ pkgs, package, module }:

let
  # Ordinary Nix build users cannot bind port 80. A nested unprivileged user/net
  # namespace exercises the gated IPv4/IPv6 regressions without host changes.
  isolatedCheck = arguments: ''
    ${pkgs.nodejs_24}/bin/node ${../scripts/check-nix-isolated-network.mjs} \
      ${pkgs.util-linux}/bin/unshare ${pkgs.iproute2}/bin/ip \
      ${pkgs.nodejs_24}/bin/npm ${arguments}
  '';
in
{
  inherit package;

  # buildNpmPackage's fixed-output dependency cache is fetched separately.
  # All check phases run in the network-isolated sandbox, with writable .cache.
  offline = package.overrideAttrs ({
    pname = "ynab-mcp-offline-check";
    npmBuildScript = "check";
    NIX_TEST_BASH = pkgs.lib.getExe pkgs.bash;
  } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    buildPhase = ''
      runHook preBuild
      ${isolatedCheck "run check"}
      runHook postBuild
    '';
  });

  http-fixtures =
    let
      # Detect a newly merged HTTP fixture that the explicit package manifest
      # forgot. Read directory names only, never credential contents.
      names = builtins.attrNames (builtins.readDir ../tests/transport-http);
      inputsPresent = pkgs.lib.all (name:
        !(pkgs.lib.hasSuffix ".ts" name) || builtins.pathExists "${package.src}/tests/transport-http/${name}"
      ) names;
    in
    assert pkgs.lib.assertMsg inputsPresent "Add every tests/transport-http/*.ts input to pkgs/ynab-mcp/default.nix";
    package.overrideAttrs {
      pname = "ynab-mcp-http-fixtures";
      NIX_TEST_BASH = pkgs.lib.getExe pkgs.bash;
      buildPhase = ''
        runHook preBuild
        # Require the HTTP application and CLI fixture inputs, not an empty run.
        test -f src/runtime/http.ts
        test -f tests/runtime/http-cli.test.ts
        test -d tests/transport-http
        ${if pkgs.stdenv.hostPlatform.isLinux then
          isolatedCheck "run test -- tests/transport-http tests/runtime/http-cli.test.ts"
        else
          "npm run test -- tests/transport-http tests/runtime/http-cli.test.ts"
        }
        npm run build
        runHook postBuild
      '';
    };

  startup = pkgs.runCommand "ynab-mcp-packaged-startup" { } ''
    installed=${package}/lib/node_modules/ynab-mcp
    test -f "$installed/dist/index.js"
    test -f "$installed/docs/tool-catalog.json"
    for excluded in src tests scripts .cache .env .env.example .git package-lock.json docs/reference node_modules/typescript node_modules/vitest; do
      test ! -e "$installed/$excluded"
    done
    # Node belongs to the test harness, not the child's PATH. The executable
    # must use its packaged interpreter without checkout dependencies.
    ${pkgs.nodejs_24}/bin/node ${../scripts/check-nix-startup.mjs} ${package}/bin/ynab-mcp
    touch "$out"
  '';
} // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  # No stub or conditional omission: missing integration is a failed check.
  nixos-service = import ../tests/nixos/ynab-mcp.nix { inherit pkgs package module; };
  nixos-safe-defaults = import ../tests/nixos/evaluation.nix { inherit pkgs module; };

  module-package =
    let
      evaluate = service: (import (pkgs.path + "/nixos/lib/eval-config.nix") {
        inherit pkgs;
        system = pkgs.stdenv.hostPlatform.system;
        modules = [ module { services.ynab-mcp = service; } ];
      }).config.services.ynab-mcp.package;
    in
    assert (evaluate { }).outPath == package.outPath;
    assert (evaluate { package = pkgs.hello; }).outPath == pkgs.hello.outPath;
    pkgs.runCommand "ynab-mcp-module-package-default" { } ''
      touch "$out"
    '';
}
