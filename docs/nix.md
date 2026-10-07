# Nix packaging and NixOS service

> **Experimental — entirely AI-agent-generated.**
> AI agents generated the application code, tests, Nix integration, and documentation under human direction.
> No human security audit is claimed. Passing tests do not guarantee correctness or safety.
> This unofficial project is not affiliated with or endorsed by YNAB.

The server can change financial records. Keep read-only mode enabled until you review the behaviour.

## Build and run

From a checkout:

```sh
nix build
nix run . -- --help
nix run . -- --version
nix flake check --no-write-lock-file
```

`packages.<system>.default` and `packages.<system>.ynab-mcp` are the same package.
Supported package/check systems are `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.
The package, checks, and development shells share `pkgs.nodejs_24` from `flake.lock`.
The current pin supplies Node **24.21.0**. Do not update the lock to run these commands.

The installed executable uses its store-pinned Node. It needs neither global Node/npm nor checkout dependencies.
Only runtime assets and production dependencies enter the installed package.
An explicit source-file allowlist excludes real `.env` files, credentials, and local build products.
Add every new application/test input to `pkgs/ynab-mcp/default.nix`; do not omit HTTP tests.

Nix can download pinned sources, binary substitutes, and the fixed-hash npm dependency cache.
After dependency acquisition, checks run offline in the Nix sandbox. They use fake tokens and local fixtures only.
They never call live YNAB. `.cache` is writable in the build tree, not in the installed package.
The HTTP manifest check rejects omitted fixture inputs instead of silently skipping merged tests.

### Transport and credentials

Stdio remains the default:

```sh
# Supply YNAB_ACCESS_TOKEN_FILE in the environment before serving.
nix run .
# Optional loopback HTTP:
nix run . -- --transport http
```

The executable never automatically reads `.env`. Set exactly one of `YNAB_ACCESS_TOKEN` or `YNAB_ACCESS_TOKEN_FILE`.
Prefer an absolute private token-file path. The file must belong to the process user and deny group/other access.
Do not use a symlink. `--help` and `--version` need no credentials.
The separate `scripts/run-local.sh` development launcher explicitly loads the checkout's `.env`.

HTTP uses `YNAB_HOST=127.0.0.1`, `YNAB_PORT=3000`, and the literal endpoint `/mcp` by default.
Only `127.0.0.1` and `::1` binds are accepted. Stdio does not require HTTP configuration.
HTTP has **no built-in authentication**. Other users on the same machine can reach the loopback service.
Do not treat loopback binding as authentication.

An external proxy is the operator's responsibility. It must provide authentication, TLS, and access policy.
It must also send headers compatible with the backend's strict Host/Origin checks.
Do not publish an unauthenticated proxy or disable those checks.
This project does not configure a proxy, public listener, or infrastructure.

## NixOS service

Import the flake module in your NixOS configuration:

```nix
{ inputs, ... }: {
  imports = [ inputs.ynab-mcp.nixosModules.default ];

  services.ynab-mcp = {
    enable = true;
    # A runtime STRING, not /run/secrets/ynab-access-token as a Nix path.
    accessTokenFile = "/run/secrets/ynab-access-token";
    allowedPlanIds = [ "00000000-0000-4000-8000-000000000001" ];
    # Defaults: loopback port 3000, core profile, read-only.
  };
}
```

Add this project's flake as `inputs.ynab-mcp` in the consuming configuration.
Replace the example UUID with the explicit plan allowlist you intend to expose.
Provision the token file at runtime with your existing secret system. Never put its contents in Nix configuration.

**Use a quoted runtime string. Do not use a Nix path, `builtins.readFile`, or an inline token.**
Those approaches can copy secrets into the world-readable Nix store.
The module requires an absolute path outside `/nix/store` and does not read its contents during evaluation.
Keep the source file private; systemd must be able to read it when the service starts.

Systemd `LoadCredential` loads the runtime source. Before startup, the service copies that credential to its own private file.
The service-owned `/run/ynab-mcp` directory has mode **0700**. Its `access-token` file has mode **0400**.
This copy preserves the application's strict owner/mode checks when systemd presents a root-owned credential with an ACL.
The runtime copy is removed when the service stops. The token never enters the unit environment or Nix store.

| Option under `services.ynab-mcp` | Default / requirement |
| --- | --- |
| `enable` | `false` |
| `package` | This flake's package for the host system |
| `host` | `"127.0.0.1"`; only that address or `"::1"` |
| `port` | `3000`; integer from 1 through 65535 |
| `accessTokenFile` | Required runtime string when enabled |
| `allowedPlanIds` | Required nonempty UUID list when enabled |
| `readOnly` | `true` |
| `toolProfile` | `"core"`; optionally `"extended"` |

The service runs `ynab-mcp --transport http` as the `ynab-mcp` system user.
It does not open a firewall port. Imports, deletes, and reconciled changes remain disabled.
An empty allowlist fails configuration; it never grants unrestricted access.
The unit applies resource limits, private temporary storage, and filesystem/capability restrictions.
Node/V8 needs a JIT, so `MemoryDenyWriteExecute` is not enabled.

`nixosModules.default` imports `modules/nixos/ynab-mcp.nix` and supplies the flake package with `lib.mkDefault`.
Thus a consuming system's nixpkgs does not replace this project's pinned Node default.
A direct `services.ynab-mcp.package = anotherPackage;` override remains valid.
Importing the raw module instead uses its fallback package from the consuming system's nixpkgs.

## Checks and CI

| Check | Coverage |
| --- | --- |
| `package` | Build and install the executable |
| `offline` | Typecheck, compiler lint, all tests, build, pinned specification |
| `startup` | Installed help/version, configuration failure, stdio initialization and safe discovery without Node/npm in PATH |
| `http-fixtures` | All `tests/transport-http` fixtures and HTTP CLI tests; no outbound YNAB |
| `nixos-safe-defaults` (Linux) | Module options, assertions, policy, credentials, and hardening |
| `module-package` (Linux) | Flake package default and direct package override |
| `nixos-service` (Linux) | Real packaged service startup, runtime security checks, and existing independent HTTP regressions in a NixOS VM |

`offline` and `http-fixtures` run ordinary npm commands inside the normal Nix sandbox.
The full native suite reports **1,039 passed and 5 skipped**. The focused HTTP suite reports **88 passed and 5 skipped**.
The five gated default-port cases cannot safely bind port 80 in ordinary native checks.
Nested user namespaces are not required: CI runners can deny writes to `/proc/self/uid_map`.

On Linux, the isolated NixOS VM runs the existing `tests/transport-http/independent.test.ts` with `YNAB_TEST_ISOLATED_NETWORK=1`.
Guest root can safely bind IPv4 and IPv6 port 80 without touching host services.
All **19 independent HTTP tests pass with zero skips**, including the exact five gated default-port regressions.
The VM verifies the JSON report, test file, total count, passed statuses, and all five gated case names.
A missing test, skip, bind failure, or ten-minute timeout fails the VM check.
The test-only artifact uses the allowlisted source and pinned development dependencies from the offline npm cache.
Vitest uses pinned Node and one worker in a private writable guest directory. VM startup does not install npm dependencies.
The production service still runs the immutable built package without development dependencies.
Guest networking remains restricted; these tests use fake connections and never call YNAB.
No host sysctl, capability, CI privilege, or security-setting changes are required.

Darwin checks also skip the five gated cases; the other tests still run.
Native aarch64 builds require a matching builder; evaluation alone does not prove they pass.

Run an individual check with, for example:

```sh
nix build .#checks.x86_64-linux.offline --no-write-lock-file
nix build .#checks.x86_64-linux.nixos-service --no-write-lock-file
```

The Linux GitHub Actions workflow runs `nix flake check`, `nix build`, and `nix run . -- --help`.
It verifies that `flake.lock` stays unchanged. Actions use verified commit pins and read-only repository permissions.
Checkout does not retain credentials. The workflow requires no YNAB credentials or workflow secrets.
KVM setup applies only to the disposable runner. The VM test supports TCG when `/dev/kvm` is absent.
No host-system or home-manager changes are required.

## Legacy Intel Darwin shell

The original `devShells.x86_64-darwin.default` definition remains present for compatibility.
The pinned nixpkgs 26.11 no longer provides `legacyPackages.x86_64-darwin`.
Therefore that legacy shell cannot evaluate with this lock. Preserving the output does not claim upstream support.
No new package/check output targets Intel Darwin. Use a supported system; do not silently change the lock.
The other existing development-shell tools and hooks remain unchanged.
