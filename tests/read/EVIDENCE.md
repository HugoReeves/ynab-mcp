# Q read fixtures

- Baseline: 28e4756. Owned paths only: src/tools/read.ts and tests/read/**.
- Red before implementation: `nix develop --command npm test -- tests/read` failed loading missing `src/tools/read.js` (session 08:40:46).
- Additional red: `npm test -- tests/read/read.test.ts -t 'opaque transaction'` expected `ok`, received `error` (08:43:20). Removed unnecessary detail-route construction; transaction detail routing now delegates to inspect.
- Green: npm ci (zero vulnerabilities); typecheck; lint; full suite 259 tests / 11 files; build; check:spec. Read suite: 80 tests including 17 independently pinned-YAML route/query audits. Fake APIs are injected into real safety and dispatcher. All 17 tools have positive/schema/exact-request and negative upstream-error fixtures. No mutations or live calls.

## Shared HTTP blocker (not changed)

Catalog accepts `{transaction_id: "opaque:txn.1"}`. Safety inspection builds the canonical path `/plans/11111111-1111-4111-8111-111111111111/transactions/opaque%3Atxn.1` (verified by the positive handler fixture). The real HTTP client's `segmentSafe` and `request` path gate in src/ynab/client.ts reject it before fetch. Shared `planPath` also rejects this valid opaque identifier.

Reproduced using built modules: createApi with a sentinel token and an injected fetch that counts calls; real createSafetyState; createReadTools; createDispatcher; call ynab_get_transaction with the above argument. Input validator returns true. Actual result: error / validation_error / "Unsafe upstream path."; fetch count 0. No network or credentials involved.

Needed H fix: accept canonically encoded catalog-valid opaque transaction path segments while still rejecting path traversal, separators, query/fragment delimiters, invalid encoding, and wrong-plan paths. Align planPath with the same safe encoding rules. Do not restrict catalog IDs to UUIDs. Q handler fixture remains strict about successful inspection and exact canonical encoding; no production HTTP checks were weakened.

Manager's separate-worker independent verification remains required; this stream provides independent fixture expectations and YAML audits, not a claim of separate-worker review.
