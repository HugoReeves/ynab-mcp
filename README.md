# ynab-mcp

> **Experimental — entirely AI-agent-generated.**
> AI agents generated this MCP's application code, tests, and documentation under human direction.
> No human security audit is claimed. Passing tests do not guarantee correctness or safety.
> This is an unofficial project, not affiliated with or endorsed by YNAB.

Third-party dependencies and the pinned YNAB API specification retain their original authorship.

This server can change or delete financial records. Start with a separate test plan,
restrict the plan allowlist, and keep writes disabled until you have reviewed the behaviour.

Local **0.1.0** MCP adapter for YNAB, using API-native `plan` terminology.
Stdio is the default transport. Optional HTTP listens only on loopback.
Node.js 24; exact server/client SDK 2.3.1 pins. Legacy `2025-11-25` and modern
`2026-07-28` exchanges are tested with the official client in subprocesses.

**Implemented:** all 35 tools. Offline checks cover the full build,
independent route contracts, subprocess stdio, and loopback HTTP fixtures.
See [implementation status](docs/implementation-status.md) for release and live-validation results.

## Install and check

With Node 24 and npm:

```sh
npm ci
npm run build
npm run check
```

Build or run the pinned Nix package without global Node/npm or checkout dependencies:

```sh
nix build
nix run . -- --help
nix flake check --no-write-lock-file
```

Nix exports packages for x86_64 Linux, aarch64 Linux, and aarch64 Darwin.
See [Nix packaging and NixOS service](docs/nix.md) for checks, runtime secrets,
and the upstream pin's legacy Intel Darwin shell limitation.

For development, Nix supplies Node/npm and hook tools:

```sh
nix develop -c npm ci
nix develop -c npm run build
nix develop -c npm run check
```

`npm run check` runs typecheck, compiler lint, offline tests, build, and the pinned
specification checks. Focus tests with `npm test -- tests/runtime` or another
stream subtree. Tests do not inherit YNAB credentials or call the live API.
`npm run generate:types` regenerates upstream types offline from the hash-checked
[OpenAPI 1.87.0 snapshot](docs/reference/ynab-openapi-1.87.0.yaml).

## Credentials and explicit configuration

The server **never automatically reads `.env`**. Supply exactly one of
`YNAB_ACCESS_TOKEN` or `YNAB_ACCESS_TOKEN_FILE` through the process environment.
Prefer an absolute token-file path: on Unix the file must be readable, owned by
you, not a symlink, and inaccessible to group/others (for example mode `600`).
Never commit credentials or paste tokens into chat, command examples, or logs.

For the explicit local launcher, create a private `.env` from
[.env.example](.env.example), set your chosen token source locally, and restrict
its permissions. **Only the launcher** loads it, using Node's `--env-file`.
Do not configure both token sources, including inherited environment values.
Node's existing environment overrides matching env-file entries.

Set `YNAB_PLAN_ID` to an explicit plan UUID for scoped tools, or provide `plan_id`
on each call. `ynab_list_plans` exposes available plans; there are no last-used
aliases or silent first-plan selection. `YNAB_ALLOWED_PLAN_IDS` optionally limits
access to a comma-separated UUID allowlist. See `.env.example` for defaults.

## Launch

```sh
# Node 24: environment already supplied, no automatic env file
node /absolute/path/to/ynab-mcp/dist/index.js
# Or, explicitly load your local file
node --env-file=/absolute/path/to/ynab-mcp/.env /absolute/path/to/ynab-mcp/dist/index.js
# Nix user, from any working directory; this explicitly loads the repo's .env
/absolute/path/to/ynab-mcp/scripts/run-local.sh
```

`npm start` runs the built stdio entry. The package `ynab-mcp` bin points to that
same shebang-equipped entry. `--help` and `--version` need no credentials; the
Nix launcher also skips env-file loading for those flags. Build before launching
from source. `nix run .` uses the built package and never loads `.env`.

For loopback HTTP, supply credentials through the process environment, then run:

```sh
nix run . -- --transport http
# With a source build instead:
node /absolute/path/to/ynab-mcp/dist/index.js --transport http
```

`YNAB_HOST` defaults to `127.0.0.1`; `YNAB_PORT` defaults to `3000`.
The endpoint is `/mcp`. HTTP has **no built-in authentication**. Other local users
can access it. An external proxy must provide authentication, TLS, access policy,
and compatible backend headers. Do not publish an unauthenticated proxy.
See [NixOS service configuration](docs/nix.md#nixos-service) for safe defaults.
Nix shell-hook diagnostics and sanitized startup errors go to stderr, never MCP
stdout. EOF, SIGINT, and SIGTERM close the connection cleanly.

Example MCP client configuration for a Nix checkout. Replace the absolute path
with your local checkout:

```json
{
  "mcpServers": {
    "ynab": {
      "command": "/absolute/path/to/ynab-mcp/scripts/run-local.sh",
      "args": []
    }
  }
}
```

No token belongs in this client configuration or in chat. Keep credentials in
your private local file/token store. A local MCP still sends returned financial
data to its client, which may be a hosted model.

## Tool availability and mutation risks

- **15 default tools:** core profile, read-only.
- **17 extended read-only tools:** `YNAB_TOOL_PROFILE=extended`, still read-only.
- **35 fully enabled tools:** extended profile, `YNAB_READ_ONLY=false`,
  `YNAB_ALLOW_DELETES=true`, and `YNAB_ALLOW_IMPORTS=true`.

Discovery and direct calls enforce the same policy. Enabling writes also permits
previews; read-only mode does not permit mutation-tool previews. Write tools
normally default to `dry_run=true`; inspect the preview before explicitly opting
into execution. Live updates/deletes require the applicable fresh revision and
preflight checks; stale revisions are not silently refreshed. Deletes require
separate permission and tool-specific confirmation. Imports may create real
transactions and require separate permission. Reconciled changes remain denied
unless separately enabled. No automatic mutation retries or rollback occur;
`applied` and `unknown` outcomes require recovery reads before any retry.

Arguments are schema-validated without coercion, inserted defaults, or field
removal; omitted values stay distinct from explicit null. Tool arguments are
limited to 1 MiB, results to 512 KiB, and the stdio read buffer to 2 MiB including
protocol overhead. Each call has a 60-second deadline and cancellation signal.
Unexpected exception text and credentials are not logged. Only protocol messages
go to stdout during serving.

## Known limits

The public API does not expose every YNAB UI operation. Pending bank transactions,
existing split-row edits, and bank connection management remain outside this adapter.
Import does not force a bank refresh. Revision checks reduce stale writes but are
not atomic conditional writes.

Target writes use conservative context checks. An account-name match cannot prove
a loan-category link; ambiguous missing-target changes are rejected before writing.
For NEED rollover, use `true` or `false`; null has no verified mapping.
Account, payee, category/group, schedule, and target write routes have offline
contract coverage. Live validation does not create permanent test objects.

## Reference

- [Tool catalog](docs/tool-catalog.json): all 35 wire contracts.
- [Implementation plan](docs/implementation-plan.md): frozen interfaces and safety gates.
- [Proposal](docs/proposal.md) and [API research notes](docs/reference/README.md).

Release checks cover `npm ci`, build, all tests, typecheck, lint, specification
checks, full-server fixtures, and executable packaging.
Live YNAB verification is separate, explicit, and never part of normal tests.
