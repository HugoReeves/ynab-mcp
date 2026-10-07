{ lib, buildNpmPackage, nodejs_24 }:

let
  root = ../..;
  package = builtins.fromJSON (builtins.readFile ../../package.json);
  # Enumerate inputs rather than importing the checkout: even untracked files in
  # source directories, credentials, and local build products stay out of Nix.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../../.env.example
      ../../docs/proposal.md
      ../../docs/reference/ynab-openapi-1.87.0.yaml
      ../../docs/tool-catalog.json
      ../../flake.nix
      ../../package-lock.json
      ../../package.json
      ../../scripts/check-spec.mjs
      ../../scripts/generate-types.mjs
      ../../scripts/run-local.sh
      ../../src/catalog.ts
      ../../src/config.ts
      ../../src/contracts.ts
      ../../src/errors.ts
      ../../src/index.ts
      ../../src/runtime/dispatcher.ts
      ../../src/runtime/http.ts
      ../../src/runtime/protocol.ts
      ../../src/runtime/server.ts
      ../../src/safety/dates.ts
      ../../src/safety/index.ts
      ../../src/tools/account-payees.ts
      ../../src/tools/categories.ts
      ../../src/tools/maintenance.ts
      ../../src/tools/read.ts
      ../../src/tools/scheduled.ts
      ../../src/tools/transactions.ts
      ../../src/ynab/client.ts
      ../../src/ynab/types.ts
      ../../tests/account-payees/independent.test.ts
      ../../tests/account-payees/tools.test.ts
      ../../tests/categories/README.md
      ../../tests/categories/categories.test.ts
      ../../tests/categories/fixtures.ts
      ../../tests/categories/independent.test.ts
      ../../tests/helpers/fixtures.ts
      ../../tests/http/TDD.md
      ../../tests/http/adversarial.test.ts
      ../../tests/http/client.test.ts
      ../../tests/http/opaque-paths.test.ts
      ../../tests/integration/protocol-fixture.ts
      ../../tests/integration/route-contracts.test.ts
      ../../tests/integration/route-fixtures.ts
      ../../tests/integration/stdio-build.ts
      ../../tests/integration/stdio-fixture.ts
      ../../tests/maintenance/independent.test.ts
      ../../tests/read/EVIDENCE.md
      ../../tests/read/read.test.ts
      ../../tests/read/spec.test.ts
      ../../tests/reads/independent.test.ts
      ../../tests/runtime/catalog.test.ts
      ../../tests/runtime/cli-launcher.test.ts
      ../../tests/runtime/cli-server.test.ts
      ../../tests/runtime/cli.test.ts
      ../../tests/runtime/dispatcher.test.ts
      ../../tests/runtime/generate-types.test.ts
      ../../tests/runtime/http-cli.test.ts
      ../../tests/runtime/independent-boundaries.test.ts
      ../../tests/runtime/independent-cli.test.ts
      ../../tests/runtime/protocol.test.ts
      ../../tests/safety/independent.test.ts
      ../../tests/safety/state.test.ts
      ../../tests/scheduled/scheduled.test.ts
      ../../tests/schedules/independent.test.ts
      ../../tests/transactions/TDD.md
      ../../tests/transactions/independent.test.ts
      ../../tests/transactions/transactions.test.ts
      ../../tests/transport-http/fixtures.ts
      ../../tests/transport-http/http.test.ts
      ../../tests/transport-http/independent.test.ts
      ../../tsconfig.build.json
      ../../tsconfig.json
      ../../vitest.config.ts
    ];
  };
in
(buildNpmPackage.override { nodejs = nodejs_24; }) {
  pname = package.name;
  inherit (package) version;
  inherit src;

  npmDepsHash = "sha256-xxKubvz1m5KL4qdcapBnf9ImpAiiSopfV0HqhlixX7U=";
  npmBuildScript = "build";

  passthru.nodejs = nodejs_24;

  # The standard hooks install offline, pack the package.json whitelist, prune
  # development dependencies, and wrap the executable with this pinned Node.
  meta = {
    description = "Model Context Protocol server for YNAB";
    mainProgram = "ynab-mcp";
    platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
  };
}
