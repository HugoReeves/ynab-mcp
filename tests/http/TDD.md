# H foundation validation record

All transport tests use injected offline fetch functions, artificial plan IDs, and fake tokens.
No `.env`, live API, global installs, or other stream implementations were used.

## Red

- `nix develop -c npm ci`: installed pinned dependencies; zero reported vulnerabilities.
- `nix develop -c npm test -- tests/http`: failed importing absent `src/config.js` (initial fixture suite written before implementation).
- Expanded fixture suite: 64 tests, 3 failures before fixes for external quota accounting, aborting stalled response streams, and loan date-keyed integer values.
- Further quota fixtures: 66 tests, 2 failures before fixes for lower server-reported quota ceilings and estimated 429 retry guidance.

## Green

- `nix develop -c npm run typecheck`
- `nix develop -c npm run lint`
- `nix develop -c npm test -- tests/http`: 75 passing tests.
- `nix develop -c npm test`: 85 passing tests across 3 files (available bootstrap plus HTTP suites).
- `nix develop -c npm run check:spec`: 35 tools, 70 schema reference trees, endpoint mappings and snapshot hash unchanged.
- `nix develop -c npm run generate:types`: repeated generation produced identical SHA-256 `3b07699f7abc5c559dfec4939407172ac67b0a346c38c96f35f43ca86df52e30` for `src/ynab/types.ts`.

## Design notes for independent review

- Connection/config/API and allowlists are frozen; the token stays in private API closures and private quota identity storage.
- Token files are opened without following symlinks; regular-file, current-user ownership, owner readability and no group/other permissions are checked against the opened inode. File reading is bounded to 64 KiB.
- Process-wide concurrency is two, including response body reads; accounting is shared by private token identity across connections. Unknown external request timestamps are conservatively held for an hour, and 429 cooldowns stop calls immediately rather than waiting.
- Request deadlines include queue waits and body reads. Fetch and stream cancellation are signalled, while promise racing also bounds noncompliant injected fetch functions.
- Strict route validation rejects percent escapes, dots, separators, query/fragment injection, origin changes and a plan different from the selected context/allowlist. Query strings use URLSearchParams only.
- GET retries are limited to two additional attempts for network failures and 502/503/504. Mutations are never retried. Uncertain mutation acknowledgments/failures are `outcome_unknown`; definite mapped rejection statuses remain `not_applied`.
- JSON source-aware numeric validation requires Node 24 (the frozen package engine). Pinned integer fields and loan periodic values reject fractional/unsafe literals; decimal currency display fields remain valid.
- Mode/symlink/regular-file behavior is fixture tested on POSIX; ownership rejection is implemented but changing file ownership is not exercised by the unprivileged tests. No live behavior is claimed.
