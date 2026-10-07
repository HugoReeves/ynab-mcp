# Implementation status: verified local release 0.1.0

## Result

All 35 catalog tools are implemented. The local stdio MCP is runnable.
Application code was implemented by delegated developers using TDD and checked by independent validation agents.

Run from any working directory:

```sh
/absolute/path/to/ynab-mcp/scripts/run-local.sh
```

This launcher explicitly loads the ignored local `.env`. See [README](../README.md) for MCP client configuration.
The server itself does not automatically load environment files.

## Offline release checks

Verification applies to the application snapshot in the initial public release.
Publication uses a clean root commit; private development history is not included.

- Clean dependency installation, strict TypeScript typecheck, compiler lint, build, and specification checks pass.
- All **951 tests in 27 files** pass, including **104 independent route-contract tests**.
- All 35 tools have positive fixture coverage. All 18 mutation tools have preview and execution coverage.
- Both legacy `2025-11-25` and modern `2026-07-28` MCP stdio exchanges pass.
- Cancellation, EOF, SIGINT/SIGTERM, frame/result byte limits, and protocol-only stdout pass.
- Discovery returns 15 default read-only, 17 extended read-only, or 35 fully permitted tools.
- Six pre-commit checks pass. Dependency audit reports zero known vulnerabilities at validation time.
- Actual npm archive installation works outside the checkout, including the executable and package-relative catalog.
- Package contents exclude credentials, environment files, private caches, and worktrees.
- The Nix launcher works without globally installed Node.js.

## Controlled live validation

All calls used the configured test plan. The allowlist was restricted to that plan during initial setup.
The PAT was never printed or committed. Live test processes used explicit permission overrides, not saved-file changes.

- Initial read-only preflight: 3 successful GET requests.
- MCP read-only discovery, scoped reads, and rejected writes: pass.
- One zero-amount manual transaction: preview, create, approve, categorise, and confirmed delete all pass.
- Approval and categorisation preserved unrelated transaction fields.
- Deletion and cleanup were confirmed.
- Account balances, account state, pre-existing transactions, and categories were unchanged.
- Live MCP attempts used **33 GETs and 4 mutations**: 30 regular GETs and 3 cleanup-reserve GETs.
- Including initial preflight, the session used **36 live GETs and 4 mutations**.
- Missing authoritative quota metadata was treated as a warning; local request limits remained enforced.
- Saved `.env` bytes were unchanged by live validation. Child processes closed cleanly.

No bank imports, schedule writes, or account/payee/category/group creation were tested live.
Those operations have offline contract coverage; live validation does not prove every remote API edge case.

## Important limits

- YNAB does not support atomic conditional writes. Fresh revisions reduce, but cannot remove, concurrent-write races.
- Import matching can have indirect effects. Imports need separate permission and were not tested live.
- Existing split-row edits and several UI-only operations are outside the public API.
- Account-name matches do not prove loan-category links. Ambiguous missing-target changes fail before writing.
- Null NEED rollover has no verified mapping; use an explicit boolean.
- Unknown mutation outcomes require read-based reconciliation, never an automatic retry.
- Default permission settings are safe, but the user's existing saved settings are preserved. Every write still defaults to a preview.

## Ownership and evidence

See [implementation plan](implementation-plan.md) for module boundaries and frozen interfaces.
Regression tests cover independently found defects in oversized-result outcome reporting, opaque-ID encoding,
category-target verification, and filtered-delta handling. Fixture defects were corrected without weakening production guards.
The original [proposal](proposal.md) remains the design baseline; [README](../README.md) describes current operation.
