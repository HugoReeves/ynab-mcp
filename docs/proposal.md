# Proposal: YNAB MCP server

Status: original design baseline; the local server is now implemented.
See [implementation status](implementation-status.md) and [README](../README.md) for verified results and current limits.

Research date: 2026-10-07. API baseline: YNAB OpenAPI 1.87.0, served under `/v1`.

Selected stack: TypeScript, Node.js 24 LTS, npm, and the official MCP TypeScript SDK.

## A) PRD (v1)

### 1. Overview

Build a local MCP server that lets an agent inspect and manage a personal YNAB plan.
Support transaction approval, categorisation, creation, editing, deletion, and scheduled transactions.
Support category assignments, supported target settings, payees, and account creation.
Use YNAB's public API only. Do not claim full UI parity.

Run one process per MCP client through stdio. Use a personal access token for the first release.
Default to read-only operation. Require explicit configuration before writes or deletions.

**Deliverables in this repository:**

- This proposal defines behaviour, configuration, scope, and acceptance criteria.
- [`tool-catalog.json`](tool-catalog.json) defines every proposed tool's input and output JSON Schema.
- [`reference/ynab-openapi-1.87.0.yaml`](reference/ynab-openapi-1.87.0.yaml) preserves the official API contract.
- [`reference/README.md`](reference/README.md) records sources and API findings.
- Nix, direnv, and pre-commit files prepare the development environment.

The tool catalog is a design artifact, not a running MCP server.
All tool names below use the `ynab_` prefix.

### 2. Problem

An agent needs structured access to YNAB without browser automation.
A generic HTTP proxy would expose too much authority and hide important financial rules.
A useful adapter must explain monetary units, resolve exact entities, and prevent silent or unintended changes.

### 3. Goals

- Complete the review flow: list unapproved transactions, inspect them, categorise them, then approve them.
- Read balances, monthly assignments, category availability, targets, and scheduled expenses.
- Expose supported writes with exact schemas and clear API mappings.
- Reject unsupported operations before submitting misleading requests.
- Never report a preview, timeout, or partial result as a confirmed change.
- Keep credentials out of model-visible tool arguments, results, and logs.

### 4. Non-goals and UI limits

| UI feature | Public API position | Proposal |
| --- | --- | --- |
| View plans, accounts, categories, months, payees | Supported | Included |
| View ordinary transactions | Supported; pending bank transactions are excluded | Included; disclose exclusion |
| Approve or unapprove transactions | Set `approved` on transaction update | Included |
| Categorise ordinary transactions | Set `category_id` | Included |
| Create split transactions | Supported with restrictions | Included |
| Change an existing split's rows | Explicitly unsupported | Reject; never delete and recreate automatically |
| Change an existing split's amount or date | API ignores these changes | Reject changes rather than report success |
| Convert a split back to one category | Existing split category cannot change | Reject |
| Scheduled transaction create/update/delete | Supported | Included |
| Create scheduled splits | Explicitly unsupported | Reject; existing scheduled splits are read-only in this adapter |
| Assign money to a category for a month | Set absolute `budgeted` value | Included |
| Move money atomically between categories | No public atomic write endpoint | Not included as a dedicated tool |
| Read money movement history and groups | Supported | Included as optional extended tools |
| Configure every target setting | Only a subset is writable | Expose only documented write fields |
| Create/rename category groups; create/edit categories | Supported | Included in extended tools |
| Hide/delete categories or groups | No matching public write endpoint in this baseline | Not included |
| Create accounts | Six account types are accepted | Included in extended tools |
| Edit/close/delete accounts; create loan account types | No matching public operation in this baseline | Not included |
| Full reconciliation workflow | No reconciliation endpoint | Allow guarded cleared-state edits, not UI reconciliation claims |
| Import available bank transactions | Supported for all linked accounts in a plan | Included as opt-in write; not bank refresh or file upload |
| Link banks, manage credentials, force bank refresh | Not exposed | Not included |
| Create/delete plans, manage users/subscription | Not exposed | Not included |
| Edit payee rename rules, merge/delete payees, manual match/unmatch, undo | Not exposed as public endpoints | Not included |
| Payee GPS locations | Read API exists | Intentionally excluded for privacy and low value |
| Reports, auto-assign, notifications, webhooks | No equivalent endpoints in this baseline | No UI-equivalence claim; calculations can use returned data |

No arbitrary-URL tool, raw request tool, browser fallback, hidden API, remote HTTP listener, or multi-user hosting belongs in v1.

### 5. Users and use cases

Primary user: Hugo, through a trusted local MCP client.

1. Review current plan health and category availability.
2. Find imported, unapproved transactions and assign exact categories.
3. Approve reviewed transactions without changing their cleared status.
4. Add manual expenses, income, supported splits, and account transfers.
5. Correct a memo, date, amount, payee, flag, category, or approval state.
6. Delete an incorrect transaction after inspecting its effects.
7. Review and maintain recurring expenses.
8. Change monthly assignments and supported category targets.

### 6. User stories

- As a plan owner, I want current balances so I can make informed spending decisions.
- As a plan owner, I want an agent to categorise transactions without silently approving them.
- As a plan owner, I want previews before writes so I can check the intended changes.
- As a plan owner, I want deletion disabled by default so mistakes remain recoverable where possible.
- As a developer, I want schemas tied to an API snapshot so implementation does not rely on guesses.

### 7. Functional requirements

**FR-01 — Transport.** The server MUST support MCP initialization, tool discovery, and tool calls over stdio.
Only protocol messages go to stdout. Diagnostic messages go to stderr.
No resources, prompts, subscriptions, or background polling are required in v1.

**FR-02 — Authentication.** Use HTTPS bearer authentication with a process-level YNAB token.
Never accept tokens as tool arguments. Never request a YNAB password.

**FR-03 — Plan selection.** A tool's explicit `plan_id` overrides `YNAB_PLAN_ID`.
Require one for plan-scoped tools. Reject missing IDs rather than silently using the last-used plan.
Accept UUIDs only; do not accept YNAB's `last-used` or OAuth `default` aliases in tools or configuration.
A configured allowlist applies after selection. Read-only discovery must also respect that allowlist.
Apply the same resolved plan to all preflight, counterpart, verification, and recovery requests.
Encode each ID as one URL path segment. Reject dot segments, path separators, percent escapes, query/fragment markers, and controls.
Validate the final normalized path against the selected plan prefix. Disable HTTP redirects to protect bearer credentials.

**FR-04 — Terminology.** Use the API's `plan`, `plan_id`, and `/plans` terminology throughout tools, schemas, and configuration.
Preserve upstream response keys such as `plans`, `plan`, `budgeted`, and `to_be_budgeted`.
Describe `budgeted` as Assigned, `balance` as Available, and `to_be_budgeted` as Ready to Assign.
Do not rename numeric response fields or invent undocumented endpoints.

**FR-05 — Validation.** Validate JSON Schema and the semantic rules in Appendix 3.
Reject unknown input fields. Distinguish omitted fields from explicit nulls.
Reject empty updates, conflicting selectors, invalid calendar dates, unsafe integers, and unsupported combinations.

**FR-06 — Reads.** Implement the core tools in Appendix 2.
Return typed data, a short text summary, freshness metadata, and revision values where relevant.
Names are display values. Writes require exact IDs; never choose an ambiguous name match.

**FR-07 — Writes.** Default every mutation to `dry_run: true`.
A preview may perform reads and validation, but MUST NOT submit an upstream mutation.
Execution requires `dry_run: false` and `YNAB_READ_ONLY=false`.
A previous preview is not required. Revisions bind entity state, not approved intent.
The host must approve the exact execution arguments; a prior preview does not authorize changed arguments.
Read-only mode omits mutation tools from discovery and rejects direct calls to them.

**FR-08 — Deletion.** Also require `YNAB_ALLOW_DELETES=true` and `confirm_delete: true` for live deletion.
Hide delete tools unless both write and delete permissions are enabled.
Show the affected transaction and known transfer counterpart in the preview.
A confirmation boolean is not proof of human approval. The MCP host must supply that approval policy.

**FR-09 — Approval.** Approval changes only `approved`.
Categorisation changes only `category_id` unless the caller separately requests another change.
Cleared, reconciled, and approved states are independent.

**FR-10 — Stale writes.** Updates and deletions require `expected_revision` from a prior read or preview.
Read the target again immediately before execution and compare its revision.
Reject stale revisions. Preview requests may omit a revision and return the current value.
This check reduces risk but is not an atomic compare-and-swap; YNAB provides no documented conditional write contract.

**FR-11 — Bulk changes.** Accept 1–100 items for transaction create/update and approval/categorisation.
This is an adapter safety limit, not a claimed YNAB limit.
Validate every item and preflight every update before sending one batch request.
Do not silently split a batch, retry individual failures, or claim upstream atomicity.

**FR-12 — History and paging.** Apply the result-size and snapshot paging rules in Appendix 4.
Expose delta tokens only where the pinned endpoint lists `last_knowledge_of_server`.
Never describe a delta response as a complete plan snapshot.

**FR-13 — API errors.** Preserve safe upstream error IDs, names, status codes, and details.
Report errors through MCP tool results with `isError: true` and structured error data.
Do not expose headers, credentials, raw response bodies, or stack traces.

**FR-14 — Extended tools.** Ship extended tools after the core contract passes its tests.
Enable them through `YNAB_TOOL_PROFILE=extended`. Core tools remain available.

### 8. Non-functional requirements

- No plan-data telemetry. No persistent financial-data cache in v1.
- Disclose that a hosted model can receive returned financial data even though the MCP process runs locally.
- Redact credentials and financial text from logs. Log tool name, status, duration, and request ID only.
- Treat payee names, category names, memos, and notes as untrusted data, never as instructions.
- Bound tool argument JSON to 1 MiB before execution. Bound memory and response sizes.
- Never silently truncate transactions or split rows.
- Use a 20-second timeout per upstream request and a 60-second total tool-call deadline.
- Limit upstream concurrency to two requests per process; serialize writes per plan.
- Track YNAB's rolling token quota. The documented ceiling is 200 requests per hour per access token.
- Respect rate-limit responses from other processes using the same token.
- Do not automatically retry mutations after timeout, connection loss, or ambiguous upstream failure.
- Retry GET requests at most twice on transient network errors or 502/503/504, within the total deadline.
- Stop on 429 and report retry guidance. Do not keep a tool call open for an hour.
- Pin development tools through `flake.lock`. Pin application dependencies when implementation begins.
- Do not send live writes in automated tests. Use fixtures and a fake YNAB service.

### 9. User flow

```text
MCP client starts Node process with token and fixed permissions
  -> list plans -> select explicit plan UUID
  -> inspect month/accounts/categories
  -> list unapproved transactions -> read selected transactions
  -> preview category or approval changes
  -> host requests user consent
  -> execute same change with returned revisions and dry_run=false
  -> server reads again, checks revisions, writes once, checks response
  -> report confirmed changes or an explicit error/unknown outcome
```

Wrong token: return an authentication error; do not retry.
Stale transaction: return a conflict; read again and request a new decision.
Write timeout: return `outcome_unknown`; inspect current state before any new attempt.
Deletion of a transfer: warn about the counterpart and let YNAB control transfer consistency.

### 10. Success metrics

- Every exposed tool has validated input and output schemas and a contract test.
- The standard review flow completes without browser automation.
- Tests prove that omitted fields remain unchanged for ordinary transaction updates.
- Tests prove that previews, read-only mode, and disabled deletions submit zero mutation requests.
- All unknown mutation outcomes remain distinguishable from success.
- No credentials or fixture financial text appear in captured logs.

### 11. Edge cases and failure modes

Cover empty plans, no matching transactions, deleted entities, hidden/internal categories, tracking accounts, and transfer payees.
Cover imported transaction matching, duplicate import IDs, same-name payees, and conflicting bulk selectors.
Cover mixed-sign splits, stale reads, month boundaries, expired paging cursors, and YNAB rate limits.
Cover null currency settings, non-two-decimal currencies, and integers beyond JavaScript's safe range.
Cover parent/subtransaction IDs, already deleted transactions, and changes made concurrently in the UI.
Never mark an unsupported operation successful because YNAB ignored one of its fields.

### 12. Open questions and assumptions

Decided: TypeScript + Node.js LTS; project name `ynab-mcp`; pre-commit checks enabled.

- Assumption: one local owner and PAT authentication are sufficient. Multi-user hosting would require separate authorization design.
- Assumption: writes use explicit preview/execute calls. Unattended automation would need a separately approved policy.
- Assumption: the core profile should load by default. Enabling all tools increases model context and available authority.
- Assumption: reconciled transactions should remain protected unless the owner explicitly enables changes.
- Assumption: extended category/account creation can follow the main transaction workflow, rather than block its first release.

API contract tests must settle the documented inconsistencies listed in the reference notes before expanding affected features.
Do not perform destructive experiments against the owner's working plan.

### 13. Acceptance criteria

- [ ] A local MCP client can initialize the process and list tools without protocol output on stderr or logs on stdout.
- [ ] A missing, empty, or conflicting token configuration fails startup without printing the token.
- [ ] A PAT can list plans and read an explicitly selected month.
- [ ] A disallowed plan cannot appear in discovery or be read or written through any tool.
- [ ] A list response clearly identifies snapshot versus delta mode and pending-transaction exclusion.
- [ ] All pages of a frozen transaction result can be read without duplicates or skipped rows, including across UTC midnight.
- [ ] Malicious opaque transaction IDs cannot escape the selected plan path.
- [ ] Approval leaves cleared status, amount, memo, and category unchanged.
- [ ] Categorisation leaves approval unchanged unless a separate update requests it.
- [ ] Null memo/category/flag values are handled separately from omission.
- [ ] A split create request validates row totals. An existing split-row edit fails before the write.
- [ ] A transfer uses the destination account's transfer payee and never submits a second independent transfer leg.
- [ ] Dry runs submit no POST, PUT, PATCH, or DELETE requests to YNAB.
- [ ] Live update/delete calls require revisions. Stale revisions fail before writing.
- [ ] Explicit updates/deletes protect reconciled targets and every known transfer counterpart, including split-transfer children.
- [ ] Import and import-matching operations require separate permission and warn that their indirect effects cannot be preflighted.
- [ ] Disabled deletion fails even if an agent fabricates a direct tool call.
- [ ] An import response with no transaction IDs is success with zero imports, not an error.
- [ ] A category assignment sends an absolute `budgeted` amount, not an increment or available balance.
- [ ] Scheduled writes enforce the future-date window and cannot create split schedules.
- [ ] Unknown write outcomes return an error that explicitly requires reconciliation before another attempt.
- [ ] Response limits never silently drop financial data.
- [ ] Schema, unit, integration, and MCP transport tests pass without real credentials.

### 14. Implementation guidance

Use TypeScript in strict mode, ESM, Node.js 24 LTS, npm, and the official MCP TypeScript SDK.
Select the current stable SDK release at implementation time. Pin its version and MCP protocol compatibility in the lockfile.
Do not assume SDK v1 and v2 have the same package names or registration APIs.

Use a thin typed HTTPS client against the pinned public API.
Generate upstream types from the OpenAPI snapshot; implement stricter write validation separately.
Use Zod or an equivalent JSON Schema-compatible validator for MCP inputs.
Use native `fetch`, abort signals, and an injectable HTTP transport for tests.
An official YNAB SDK is acceptable only if its generated schema matches the selected API baseline.

Suggested modules:

```text
src/
  index.ts                 # startup, stdio, shutdown
  config.ts                # token source and immutable permissions
  ynab/client.ts           # HTTPS, envelopes, rate limits, error mapping
  ynab/types.ts            # generated upstream types
  policy.ts                # plan allowlist, writes, deletes, reconciliation
  revisions.ts             # canonical entity hashes and stale-write checks
  paging.ts                # bounded, process-local snapshots
  schemas/                 # tool inputs and output validators
  tools/read.ts
  tools/transactions.ts
  tools/scheduled.ts
  tools/extended.ts
```

## B) Clarifying questions before implementation

The proposal uses safe defaults and is complete enough to start read-only development.
These choices affect later write behaviour:

1. Should writes always need host approval, or can a defined subset run unattended?
2. Should the token be restricted locally to one plan or several plans?
3. Should the first release include the extended profile, or only the core transaction workflow?

## C) Implementation task breakdown

### M1 — Safe read-only server

Dependencies: token available only for optional manual testing; no token needed for automated tests.

- Implement immutable configuration parsing and secret redaction.
- Build HTTPS client, typed envelopes, quota accounting, and safe error mapping.
- Register core read tools and JSON Schema validation.
- Implement plan scoping, bounded snapshots, revisions, and result metadata.
- Add fixture-based API tests and stdio client integration tests.

Done: a local client can read a complete review dataset; all policy and transport tests pass.

### M2 — Transaction management

Depends on M1.

- Add transaction create/update, bulk operations, approval, categorisation, and import.
- Add previews, expected revisions, transfer/split validation, and reconciled-state protections.
- Add deletion behind its separate permission gate.
- Test duplicate imports, unchanged fields, stale revisions, transfer effects, and unknown outcomes.

Done: every requested ordinary transaction action works against the fake service and passes the acceptance tests.

### M3 — Schedules and plan maintenance

Depends on M2 policy and write handling.

- Add scheduled transaction writes and date validation.
- Add category assignment, category/group maintenance, supported targets, payee maintenance, and account creation.
- Add money movement history tools and the extended profile.
- Resolve target and money-movement documentation differences with non-destructive contract checks.

Done: every catalog tool has a transport-level contract test and documented limitations.

### M4 — Release and manual checks

- Add npm build/start/test/lint/typecheck commands and lock dependencies.
- Add a packaged executable, setup instructions, client examples, and migration notes.
- Test read-only access against a consenting owner's plan.
- Test writes only against a separate test plan with explicit approval.
- Enable ordinary writes first. Enable deletes only after the owner reviews the policy.
- Keep telemetry disabled. Roll back by disabling writes or stopping the local process.

## Appendix 1 — Authentication and process configuration

### Personal access token: required for v1

Create a token through YNAB's Developer Settings: <https://app.ynab.com/settings/developer>.
Use it as `Authorization: Bearer <token>` against `https://api.ynab.com/v1`.
A PAT is a powerful account credential. Local plan restrictions do not reduce the PAT's upstream authority.

Exactly one token source is required:

| Environment variable | Required/default | Meaning |
| --- | --- | --- |
| `YNAB_ACCESS_TOKEN` | One token source required | PAT injected by the launching process |
| `YNAB_ACCESS_TOKEN_FILE` | Alternative to token variable | Absolute path to a UTF-8 file containing only the PAT; trim outer whitespace |
| `YNAB_PLAN_ID` | Optional | Default plan UUID; otherwise each scoped tool needs `plan_id` |
| `YNAB_ALLOWED_PLAN_IDS` | Optional; all token-accessible plans | Comma-separated UUID allowlist; reject empty elements or invalid UUIDs |
| `YNAB_READ_ONLY` | `true` | Strict `true` or `false`; false permits non-delete write tools |
| `YNAB_ALLOW_DELETES` | `false` | Enables delete tools only when read-only is false |
| `YNAB_ALLOW_RECONCILED_CHANGES` | `false` | Permits explicit editing/deletion of reconciled transactions and setting reconciled state |
| `YNAB_ALLOW_IMPORTS` | `false` | Permits the import tool and non-null `import_id` on creates; matching effects cannot be fully preflighted |
| `YNAB_TOOL_PROFILE` | `core` | `core` or `extended`; extended includes core |
| `YNAB_TIMEOUT_MS` | `20000` | Integer 1000–60000; per upstream request, still subject to 60-second call deadline |
| `YNAB_CACHE_TTL_SECONDS` | `30` | Integer 0–300; reusable GET result cache, separate from frozen paging snapshots |
| `YNAB_LOG_LEVEL` | `warn` | `error`, `warn`, or `info`; stderr only; no payload-level debug logging |

Token files must be ordinary readable files owned by the current user, with no group/other access on POSIX.
Reject both token sources being set, an empty token, or embedded newline characters after trimming.
Reject configurations whose default plan is outside the allowlist.

The production API base URL is fixed. Do not accept a base URL through tool input or ordinary environment configuration.
Tests inject a fake client; this avoids credential exfiltration through an agent-selected host.

The process accepts `--help` and `--version`. It requires no authentication CLI flags.
Do not accept tokens on the command line because process listings and shell history can expose them.
Do not auto-load `.env`; the launcher or a secret manager supplies the environment.
`.env.example` is documentation, not a file containing a real token.

### Proposed MCP client configuration

This becomes usable after implementation and `npm run build`:

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp/dist/index.js"],
      "env": {
        "YNAB_ACCESS_TOKEN_FILE": "/absolute/private/path/ynab-token",
        "YNAB_PLAN_ID": "11111111-1111-4111-8111-111111111111",
        "YNAB_ALLOWED_PLAN_IDS": "11111111-1111-4111-8111-111111111111",
        "YNAB_READ_ONLY": "true",
        "YNAB_ALLOW_DELETES": "false",
        "YNAB_TOOL_PROFILE": "core"
      }
    }
  }
}
```

Use an absolute Node executable path if the MCP host does not inherit a suitable PATH.
The Nix shell provides Node during development. The configuration above is not an installed service.

### OAuth: future distribution option, not required for this project

PAT mode needs no client ID, client secret, redirect URI, username, or password.
For a future application used by other YNAB users, use YNAB's authorization-code flow instead.

A future OAuth implementation would need `client_id`, `client_secret`, an exactly registered `redirect_uri`,
a cryptographically random validated `state`, and a secure token store for access/refresh tokens and expiry.
YNAB's authorization endpoint is `https://app.ynab.com/oauth/authorize`.
Its token endpoint is `https://app.ynab.com/oauth/token`.
Use PKCE S256 and validate `state`. The documented code exchange still requires a client secret.
Use returned expiry data; access tokens currently expire after two hours.
Store any replacement refresh token atomically. Do not assume a documented rotation or lifetime guarantee.
Use `scope=read-only` for read-only authorization; omit that scope for read/write access as documented by YNAB.
Do not invent a `transactions:write` or per-plan scope.

OAuth default-plan selection and application approval limits need separate product decisions.
OAuth credentials and refresh logic are explicitly not part of the v1 environment contract.
A remotely hosted MCP would also need MCP-client authorization, not merely an upstream YNAB token.

## Appendix 2 — Tool catalog and endpoint mappings

### Contract notation

The linked JSON catalog is normative for field types, required fields, bounds, enums, and response shapes.
Appendix 3 adds semantic rules that JSON Schema cannot enforce alone.

- `B`: optional `plan_id: UUID`; required after resolving the environment default.
- `P`: optional `page_size: integer=100` (1–500), `cursor: string`; see paging rules.
- `K`: optional `last_knowledge_of_server: nonnegative safe integer`.
- `W`: optional `dry_run: boolean=true`.
- `R`: optional `expected_revision: string`; required at runtime for live updates/deletes.
- `ID`: UUID except transaction IDs, which are nonempty opaque strings.
- `Month`: `YYYY-MM-01`; reads also accept `current` and resolve it once in UTC.
- Every listed path is relative to `https://api.ynab.com/v1`.
- `{b}` means the resolved upstream plan UUID. Tool `plan_id` becomes `{plan_id}`.
- Success data preserves the `data` object's shape from the named upstream response schema.

### Core read tools

| Tool | Inputs in addition to B | Upstream mapping | Success data schema |
| --- | --- | --- | --- |
| `ynab_get_user` | None; no B | `GET /user` | `UserResponse.data` |
| `ynab_list_plans` | `include_accounts?: boolean=false`, P; no B | `GET /plans` | `PlanSummaryResponse.data` |
| `ynab_get_plan_settings` | None | `GET /plans/{b}/settings` | `PlanSettingsResponse.data` |
| `ynab_list_accounts` | K, P | `GET /plans/{b}/accounts` | `AccountsResponse.data` |
| `ynab_get_account` | `account_id` | `GET /plans/{b}/accounts/{account_id}` | `AccountResponse.data` |
| `ynab_list_categories` | K, P | `GET /plans/{b}/categories` | `CategoriesResponse.data` |
| `ynab_get_category` | `category_id`, `month?: Month` | With month: `GET /plans/{b}/months/{month}/categories/{category_id}`; otherwise `/categories/{category_id}` | `CategoryResponse.data` |
| `ynab_list_months` | K, P | `GET /plans/{b}/months` | `MonthSummariesResponse.data` |
| `ynab_get_month` | `month: Month` | `GET /plans/{b}/months/{month}` | `MonthDetailResponse.data` |
| `ynab_list_payees` | K, P | `GET /plans/{b}/payees` | `PayeesResponse.data` |
| `ynab_get_payee` | `payee_id` | `GET /plans/{b}/payees/{payee_id}` | `PayeeResponse.data` |
| `ynab_list_transactions` | `scope?: TransactionScope`, `since_date?`, `until_date?`, `type?: unapproved\|uncategorized`, K, P | See routing below | `TransactionsResponse.data` or `HybridTransactionsResponse.data` |
| `ynab_get_transaction` | `transaction_id: string` | `GET /plans/{b}/transactions/{transaction_id}` | `TransactionResponse.data` |
| `ynab_list_scheduled_transactions` | K, P | `GET /plans/{b}/scheduled_transactions` | `ScheduledTransactionsResponse.data` |
| `ynab_get_scheduled_transaction` | `scheduled_transaction_id` | `GET /plans/{b}/scheduled_transactions/{scheduled_transaction_id}` | `ScheduledTransactionResponse.data` |

`ynab_get_month` is the normal plan overview: Ready to Assign, income, activity, assignments, and category availability.
Combine it with accounts and settings instead of fetching the large full-plan export.
The full `GET /plans/{b}` endpoint is intentionally not exposed in v1.

`TransactionScope` is one of these strict objects:

```ts
{ kind: "plan" } // default
{ kind: "account", account_id: UUID }
{ kind: "category", category_id: UUID }
{ kind: "payee", payee_id: UUID }
{ kind: "month", month: Month }
```

Route to `/transactions`, `/accounts/{id}/transactions`, `/categories/{id}/transactions`,
`/payees/{id}/transactions`, or `/months/{month}/transactions`, respectively.
Pass only the documented date, type, and knowledge query parameters.
Category/payee routes return hybrid rows. A hybrid row may represent a subtransaction and includes its parent ID.
Do not pass a hybrid subtransaction ID to a parent update tool.
To combine filters, fetch an appropriate scope and filter locally in the client; v1 has no arbitrary search expression.

### Core write tools

All write tools include B and W. Tools are available only when writes are enabled.

| Tool | Other inputs | Upstream mapping | Success data schema |
| --- | --- | --- | --- |
| `ynab_create_transactions` | `transactions: NewTransaction[1..100]` | `POST /plans/{b}/transactions`, body `{transactions}` | `SaveTransactionsResponse.data` |
| `ynab_update_transaction` | `transaction_id`, `changes: TransactionPatch`, R | `PUT /plans/{b}/transactions/{id}`, body `{transaction: changes}` | `TransactionResponse.data` |
| `ynab_update_transactions` | `transactions: TransactionUpdate[1..100]` | `PATCH /plans/{b}/transactions`, body `{transactions: strippedItems}` | `SaveTransactionsResponse.data` |
| `ynab_set_transaction_approval` | `transactions: TransactionReference[1..100]`, `approved: boolean` | Same PATCH; items contain only `id` and `approved` | `SaveTransactionsResponse.data` |
| `ynab_categorize_transactions` | `transactions: TransactionReference[1..100]`, `category_id: UUID\|null` | Same PATCH; items contain only `id` and `category_id` | `SaveTransactionsResponse.data` |
| `ynab_delete_transaction` | `transaction_id`, R, `confirm_delete?: boolean=false` | `DELETE /plans/{b}/transactions/{id}` | `TransactionResponse.data` |
| `ynab_import_transactions` | No additional input | `POST /plans/{b}/transactions/import`, no body | `TransactionsImportResponse.data` |
| `ynab_create_scheduled_transaction` | `scheduled_transaction: ScheduledWrite` | `POST /plans/{b}/scheduled_transactions`, body `{scheduled_transaction}` | `ScheduledTransactionResponse.data` |
| `ynab_update_scheduled_transaction` | `scheduled_transaction_id`, `scheduled_transaction: ScheduledWrite`, R | `PUT /plans/{b}/scheduled_transactions/{id}`, body `{scheduled_transaction}` | `ScheduledTransactionResponse.data` |
| `ynab_delete_scheduled_transaction` | `scheduled_transaction_id`, R, `confirm_delete?: boolean=false` | `DELETE /plans/{b}/scheduled_transactions/{id}` | `ScheduledTransactionResponse.data` |

`TransactionReference = {id: string, expected_revision?: string}`.
`TransactionUpdate = {id: string, changes: TransactionPatch, expected_revision?: string}`.
For live batches, every item needs its own revision. Duplicate IDs are invalid.
The adapter accepts updates by ID only. Upstream update-by-`import_id` is intentionally excluded because IDs are less ambiguous.

`NewTransaction` requires `account_id`, `date`, and `amount` even though the upstream generated model is less strict.
Optional fields: `payee_id`, `payee_name`, `category_id`, `memo`, `cleared`, `approved`, `flag_color`, `subtransactions`, `import_id`.
`TransactionPatch` accepts the same optional fields except `import_id`, and requires at least one change.
Only non-split transactions can receive a new `subtransactions` array.

`ScheduledWrite` requires `account_id`, `date`, `amount`, and `frequency`.
Optional fields: `payee_id`, `payee_name`, `category_id`, `memo`, and `flag_color`.
This adapter requires amount/frequency explicitly to avoid relying on unspecified API defaults.
For schedule updates, pre-read the record and preserve omitted optional fields, except the coupled payee selectors.
A supplied non-null name clears the old payee ID. A supplied non-null ID omits the old name.
An explicit null selector without a non-null replacement clears both selectors; never restore the old payee through merging.
If both selectors are omitted, preserve the current payee ID, or the current name when no ID exists.
Reject two non-null selectors. Apply these rules after input validation and before constructing the upstream body.
Translate `date_next` from reads to write field `date`; do not send read-only fields.

### Extended tools

Require `YNAB_TOOL_PROFILE=extended`. Read tools do not require write permission.

| Tool | Inputs in addition to B | Upstream mapping | Success data schema |
| --- | --- | --- | --- |
| `ynab_list_money_movements` | `month?: Month`, P | `GET /plans/{b}/money_movements` or `/months/{month}/money_movements` | `MoneyMovementsResponse.data` |
| `ynab_list_money_movement_groups` | `month?: Month`, P | `GET /plans/{b}/money_movement_groups` or `/months/{month}/money_movement_groups` | `MoneyMovementGroupsResponse.data` |
| `ynab_create_account` | `account: {name, type, balance}`, W | `POST /plans/{b}/accounts`, body `{account}` | `AccountResponse.data` |
| `ynab_create_payee` | `name: string`, W | `POST /plans/{b}/payees`, body `{payee:{name}}` | `SavePayeeResponse.data` |
| `ynab_update_payee` | `payee_id`, `name: string`, W, R | `PATCH /plans/{b}/payees/{id}`, body `{payee:{name}}` | `SavePayeeResponse.data` |
| `ynab_create_category_group` | `name: string`, W | `POST /plans/{b}/category_groups`, body `{category_group:{name}}` | `SaveCategoryGroupResponse.data` |
| `ynab_update_category_group` | `category_group_id`, `name: string`, W, R | `PATCH /plans/{b}/category_groups/{id}`, body `{category_group:{name}}` | `SaveCategoryGroupResponse.data` |
| `ynab_create_category` | `category: NewCategory`, W | `POST /plans/{b}/categories`, body `{category}` | `SaveCategoryResponse.data` |
| `ynab_update_category` | `category_id`, `changes: CategoryPatch`, W, R | `PATCH /plans/{b}/categories/{id}`, body `{category:changes}` | `SaveCategoryResponse.data` |
| `ynab_set_category_assignment` | `category_id`, `month: YYYY-MM-01`, `budgeted: milliunits`, W, R | `PATCH /plans/{b}/months/{month}/categories/{id}`, body `{category:{budgeted}}` | `SaveCategoryResponse.data` |

A group revision comes from the matching group in `ynab_list_categories`.
A monthly assignment revision comes from `ynab_get_category` with the exact target month.
Category metadata updates use a revision from `ynab_get_category` without a month.

`NewCategory` requires nonempty `name` and `category_group_id`.
`CategoryPatch` requires at least one field.
Both accept only documented fields: `name`, `note`, `category_group_id`, `goal_target`, `goal_target_date`,
`goal_needs_whole_amount`, and `goal_frequency`.
The adapter does not expose `goal_type`, `goal_day`, `goal_cadence`, `hidden`, or `deleted` as writable fields.

## Appendix 3 — Field semantics and write safety

### Amounts, dates, IDs, and nulls

- All amount inputs use integer milliunits. `-12340` means an outflow of 12.34 currency units.
- Positive transaction amounts are inflows. Negative amounts are outflows. Zero is allowed where YNAB accepts it.
- Do not accept floating-point currency inputs or perform arithmetic using `*_currency` response fields.
- Validate every integer against JavaScript's safe range. Reject unsafe upstream integers instead of silently rounding them.
- Currency formatting is presentation only. One plan has one currency format, which can be unavailable/null.
- Dates use valid calendar `YYYY-MM-DD` strings. Months use the first day of the month.
- Resolve read alias `current` once using UTC and include the resolved month in metadata.
- Writes require explicit months and dates. Do not infer a user's local timezone from the machine timezone.
- Ordinary transaction dates cannot be future dates. Scheduled dates must be future dates within five years.
- Compare dates using the documented UTC month convention in v1; surface any stricter YNAB validation without coercion.
- Transaction IDs are opaque strings, not assumed UUIDs. Scheduled/account/category/payee/plan IDs are UUIDs.
- Opaque IDs still need URL safety: reject `/`, `\\`, `?`, `#`, `%`, controls, whitespace, and the exact values `.` or `..`.
- Omission means leave unchanged on patch-like tools. Null means clear only where the field permits it.
- `memo` allows null or at most 500 characters. Transaction `payee_name` allows null or at most 200 characters.
- Standalone payee create/rename allows 1–500 characters. Category group names allow 1–50 characters.
Reject direct renaming of transfer payees in this adapter; account management owns their meaning.
- Do not invent a category-name length limit absent from the pinned schema; require a nonempty name in this adapter.
- Flags accept red, orange, yellow, green, blue, purple, or null. Normalize upstream empty-string flags to null on input handling.
- Read `flag_name` if present, but do not expose a flag-label write field.
- `cleared` accepts `uncleared`, `cleared`, or `reconciled`; reconciliation policy applies to every tool path.

### Revisions and permissions

Define a revision as `sha256:<64 lowercase hex characters>` over canonical JSON.
Include the resolved plan ID, entity kind, entity ID, and exact month context where applicable.
Sort object keys. Sort child arrays by stable child ID for revision purposes only.
Exclude display-only `*_formatted` and `*_currency` fields. Do not exclude mutable financial fields.
Use these canonical entity projections, not whichever API representation happens to be available:

| Entity | Eligible revision source and fields |
| --- | --- |
| Transaction | Complete `TransactionDetail` from detail GET or preflight; include all non-display fields and complete children |
| Scheduled transaction | Complete `ScheduledTransactionDetail` from detail GET or preflight; include all non-display fields and children |
| Payee | Detail GET/preflight; `id`, `name`, `transfer_account_id`, `deleted` |
| Category metadata | Category GET without month; `id`, `name`, `note`, `category_group_id`, `hidden`, `internal`, `deleted`, and all `goal_*` fields except display/derived progress fields |
| Monthly assignment | Exact month-category GET; `id`, resolved month, `budgeted`, `activity`, `balance`, `hidden`, `internal`, `deleted` |
| Category group | Full non-delta categories GET; `id`, `name`, `hidden`, `internal`, `deleted`; exclude nested categories |

For category goals, include only `goal_type`, `goal_target`, `goal_target_date`, `goal_needs_whole_amount`,
`goal_day`, `goal_cadence`, `goal_cadence_frequency`, `goal_creation_month`, and `goal_snoozed_at`.
Normalize absent optional projection fields to null. Include only the named fields where a whitelist is specified.
For transaction/schedule detail, exclude only display fields; require the complete documented detail representation.

Do not issue write revisions from hybrid rows, delta records, or transaction lists. Use detail reads or previews instead.
For transfers, fetch every distinct counterpart, including `subtransactions[].transfer_transaction_id`.
Include counterpart states in the parent's revision and preview; use a visited-ID set to avoid cycles.
Return revision keys as `<kind>:<id>` or `category:<id>:<YYYY-MM-01>` for month-specific categories.

Preflight reads bypass caches. Strip `expected_revision`, `dry_run`, and `confirm_delete` from upstream bodies.
Do not send `If-Match` or a fabricated API version parameter.
Execution checks policy again even if preview succeeded. A preview grants no extra permissions.
Block explicit edits/deletes to reconciled transactions, edits of any affected transfer counterpart, and writes setting `cleared=reconciled`
unless `YNAB_ALLOW_RECONCILED_CHANGES=true`.
Check every split-transfer child counterpart, not only the parent's transfer link.
Reject bulk requests whose affected transaction sets overlap, including both legs of one transfer.
This protection covers explicit target graphs. It cannot guarantee the indirect effects of YNAB's opaque import matching.
This is not a full account reconciliation action and does not promise to update account reconciliation metadata.

### Ordinary and split transactions

Read the target before updates. Apply only the requested ordinary fields to upstream PUT/PATCH bodies.
A transaction defaults to unapproved upstream if approval is not supplied during creation.
For predictable creates, explicitly submit `approved=false` and `cleared=uncleared` when omitted.
Never inject create defaults into an update.

Reject both a non-null `payee_id` and a non-null `payee_name` in the same submitted object.
YNAB otherwise prioritizes an ID. The stricter adapter prevents ambiguous intent.
On an update that supplies `payee_name` without a non-null ID, explicitly submit `payee_id:null` for name resolution.
A new name can create a payee. Include this possibility in previews.
Payee rename rules can affect imported transactions; do not implement a second rename-rule engine.

A split requires `category_id:null` and at least two subtransactions in this adapter.
Each child has required `amount` and optional payee, category, and memo fields.
Limit each split to 100 child rows as an adapter safety policy.
The exact integer sum of child amounts must equal the parent amount.
Allow mixed signs where the sum is valid. Never balance or round the last row automatically.
Reject tracking-account splits and on-budget-to-on-budget transfer splits.
A transfer to a tracking account can be split subject to YNAB's documented rules.
Existing split rows cannot be updated. Parent amount/date/category changes that differ from current values must fail.
Supported parent metadata edits can proceed if their returned fields match the request.
Do not expose an independent subtransaction update endpoint.

### Transfers and categories

Use the destination account's `transfer_payee_id` to create a transfer.
Read accounts to validate that the transfer stays inside the selected plan and does not target the same account.
Do not create the balancing leg yourself. YNAB manages the linked transfer.
Inspect the counterpart before changing/deleting a transfer. Report known affected IDs.
Do not claim precise counterpart deletion or recategorisation effects without observing YNAB's result.

Transfers between on-budget accounts normally have no category.
Transfers crossing the on-budget/tracking boundary can need a category on the on-budget side.
Validate account context instead of applying one blanket category rule to all transfers.
Reject Credit Card Payment categories for transaction categorisation; YNAB documents that it ignores them.
Do not reject all internal categories indiscriminately: Ready to Assign is a valid inflow category.
Hidden categories remain visible in reads. Reject deleted categories and warn before assigning a hidden category.

### Import IDs and bank import

An optional transaction `import_id` is at most 36 characters and is unique per account.
It marks a transaction as imported and can cause matching to a user-entered transaction.
Two imported transactions do not match each other; do not promise matching with a separate bank-imported record.
YNAB describes matching by account, equal amount, and a date within plus/minus ten days.
A duplicate may produce HTTP 409 or appear in `duplicate_import_ids` for bulk creation.
Preserve this difference. Do not label every input as newly created.
Never fabricate an import ID for an ordinary manual expense.
Never offer a generic idempotency-key guarantee based on `import_id`.
A non-null `import_id` requires `YNAB_ALLOW_IMPORTS=true`, even during preview.
Warn that matching may alter an existing record whose identity and reconciled state cannot be reliably predicted.
Do not claim that explicit-target reconciliation guards cover those indirect effects.

The import tool requires `YNAB_ALLOW_IMPORTS=true` and write permission; otherwise omit it from discovery and reject direct calls.
It triggers available imports across all linked accounts in the plan.
It cannot select one account, upload a file, reconnect a bank, or guarantee newly fetched bank data.
Its preview shows this scope but cannot know which IDs will be imported.
A zero-ID import response is a successful no-op.

### Scheduled transactions

Expose all documented frequencies: `never`, `daily`, `weekly`, `everyOtherWeek`, `twiceAMonth`, `every4Weeks`,
`monthly`, `everyOtherMonth`, `every3Months`, `every4Months`, `twiceAYear`, `yearly`, `everyOtherYear`.
`never` means a one-time future transaction.
A schedule read uses `date_first` and `date_next`; a write uses `date`.
Do not accept `approved`, `cleared`, `import_id`, or `subtransactions` in scheduled writes.
Protect existing split schedules from all update tools in v1; deletion still requires the deletion policy.

### Monthly assignments and targets

`budgeted` is an absolute assigned amount for that month, not an increment and not the available balance.
Read the month category before an assignment and return its revision and before/after amount.
Do not clamp negative assigned amounts to zero; let documented YNAB validation decide valid amounts.
Two category assignments do not constitute an atomic money movement.
Do not implement an automatic rollback that could overwrite concurrent user changes.

`goal_target:null` removes a target on update. Non-null target amounts must be nonnegative in this adapter.
For loan-linked DEBT targets, only `goal_target` changes the monthly payment amount; preserve the target type.
`goal_frequency` accepts `monthly`, `weekly`, or `yearly`; it requires a non-null `goal_target`.
It replaces the existing target with a recurring NEED target.
It cannot accompany `goal_target_date` and is unsupported for Credit Card Payment or loan-linked categories.
`goal_needs_whole_amount` applies only to supported NEED goals: true means Set Aside; false means Refill.
Target dates are unsupported for loan-linked categories.
Read existing target/account context before validating target edits.
Do not infer that read-only `goal_type` is writable from prose that mentions its default.

## Appendix 4 — Results, paging, caching, errors, and rate limits

### MCP result envelope

Every tool returns `structuredContent` matching its output schema plus a short `content` text block.
Use `isError:true` for execution/policy/upstream errors. A dry-run result is a successful preview, not a write.
All envelopes include `status` and `meta`. The catalog defines a discriminated union:

```ts
type Result<T> =
  | { status: "ok"; data: T; meta: Meta }
  | { status: "preview"; preview: Preview; meta: Meta }
  | { status: "error"; error: ToolError; meta: Meta };
```

`Meta` includes `request_id`, `fetched_at`, `warnings`, and optional `plan_id`, `resolved_month`,
`mode`, `cache_hit`, `revisions`, `next_cursor`, `complete`, `returned_count`, `total_count`, and `rate_limit`.
Transaction results also include `resolved_scope`, and applicable `resolved_since_date` and `resolved_until_date` values.
`mode` is `snapshot` or `delta`. `fetched_at` records source fetch time, not cursor retrieval time.
Revisions are metadata, not invented upstream entity fields.

`Preview` includes HTTP method/path/body, validation status, before-state summaries, expected revisions,
affected entity IDs, and warnings. Exclude all authorization headers and tokens.
Preview values are sensitive financial data; return them to the client but never log them.
For imports, mark the set of future transaction IDs as unknown.

After successful writes, verify against authoritative entities using endpoint-specific comparisons:

- Ordinary ID-based updates compare submitted fields; approval/category helpers compare only their single intended field.
- Resolve payee-name writes to the returned payee identity. Do not require the input name to survive an applicable rename rule.
- Scheduled write `date` compares to returned `date_next`; `frequency` and other writable fields compare directly.
- Monthly assignments compare the returned category's `budgeted` value for the exact month.
- Target frequency compares NEED type, target amount, and cadence: monthly=1, weekly=2, yearly=13, with cadence frequency=1.
- Target removal checks that the target is absent. Other supported target fields compare to their documented read equivalents.
- Establish recurring-target and schedule comparison fixtures before enabling their writes; gate unresolved mappings rather than assume success.
- If a save response supplies IDs but omits entities, GET those IDs before claiming verified field values.
- Match bulk update results by ID, never by array position. Report absent/unverified IDs explicitly.
- For bulk creates, report saved IDs and duplicate import IDs. Do not invent per-input identity mapping from array order.
- Verify unambiguous create matches or the complete requested/observed multiset after supported normalization.
- Deletion uses the API acknowledgment; if the returned entity contradicts deletion, verify by GET before reporting success.
- Re-read affected transfer counterparts after mutations and report their observed state or an explicit verification gap.
- Bank import confirms only the acknowledged imported IDs, not a predicted set or bank refresh.

If an acknowledged write differs from intended values, or verification cannot finish within quota/deadline,
return `verification_failed` with `outcome:"applied"`, acknowledged IDs, and safe observed data.
If application itself cannot be determined, return `outcome_unknown` with `outcome:"unknown"`.
Never automatically repeat the write. Tell the caller which read tool can reconcile the result.

### Paging and memory limits

YNAB does not provide ordinary offset/page-token pagination for these list endpoints.
The adapter implements local paging over a frozen upstream response, not upstream pagination.

- First call fetches the complete selected upstream result, subject to an 8 MiB response-byte limit.
- Filter disallowed plans before creating a plan-list snapshot, including `default_plan`.
- Page only the primary collection: `plans`, `accounts`, `category_groups`, `months`, `payees`, `transactions`,
  `scheduled_transactions`, `money_movements`, or `money_movement_groups`.
- Preserve nested child arrays whole. Category pages contain groups, not individual category rows.
- Include revision metadata only for entities present on the returned page.
- Preserve upstream order within a snapshot. Do not refetch upstream for a continuation page.
- Return `complete:false` and `next_cursor` when more items remain. The final page has `complete:true` and no cursor.
- A continuation repeats the original selectors and page size, plus its cursor. Reject mismatches.
- Reuse the first page's resolved dates and month. Never resolve omitted dates or `current` again for a continuation.
- Bind opaque, random cursors to the process, resolved plan, tool, normalized arguments, and snapshot.
- Snapshots expire after five minutes. Limit total cached/snapshot payloads to 64 MiB with oldest-first eviction.
- Expired/evicted/mismatched cursors return `cursor_invalid`; they never restart silently.
- Bound each serialized MCP result to 512 KiB. Shorten a page at item boundaries if necessary.
- If one entity or an unpaged result cannot fit, return `response_too_large`; do not drop fields or child rows.
- Explain that narrowing transaction dates/scope reduces upstream result size. Client paging alone does not.
- An empty collection is success with zero items and `complete:true`.

The GET cache uses the configured TTL and keys by token identity, plan, endpoint, and all normalized query arguments.
Token identity uses a process-private value; never store the raw token in a visible cache key.
Invalidate the plan's cache and paging snapshots after every submitted mutation, including ambiguous failures.
A prior cursor then fails explicitly. Do not return known-stale pages as current data.
Preflight requests and explicit revision checks always bypass the cache.

### Delta requests and date windows

Return `server_knowledge` wherever the upstream response provides it.
Only forward `last_knowledge_of_server` to endpoints whose pinned parameter list declares it.
A delta returns changed entities, including deletion markers where supported, not a full replacement dataset.
Keep tombstones in delta pages. Never filter them away as inactive records.

A caller must retain separate knowledge tokens for each exact endpoint/filter/date-window dataset.
It must apply every page before committing the new knowledge token, even though each page repeats that token.
Changing filters, moving a date window, or losing the local dataset requires a full fetch without a token.
Do not use a token from one endpoint or filtered result to advance another dataset.
A caller must not assume a filtered delta reports entities that stopped matching its filter; refresh such views fully.
The adapter itself does not merge caller deltas into a persistent database in v1.

Transaction endpoints other than month scope default `since_date` to one year ago when omitted.
Resolve that default to an explicit date for metadata, cache keys, cursors, and the submitted query.
Do not label this result “all history.” Request an explicit earlier date for older history.
Month scope is bounded by the selected month. Validate `since_date <= until_date` and their month intersection.
Neither path includes pending bank transactions.

The narrative docs mention money-movement deltas, but their pinned endpoint parameter lists omit the knowledge parameter.
Do not expose that input on money-movement tools until YNAB resolves or testing confirms the contract.

### Error schema

`ToolError` has required `code`, `message`, `retryable`, and `outcome`.
It may include `http_status`, `upstream:{id,name,detail}`, `retry_after_seconds`, `details`, and `recovery_tool`.
`outcome` is `not_applied`, `applied`, or `unknown`.
Use `not_applied` for local validation/permission failures and reads. Do not assume it for ambiguous write failures.
For bulk requests, treat unverified item outcomes conservatively; do not promise rollback on a whole-request error.

Codes: `configuration_error`, `validation_error`, `authentication_error`, `permission_denied`, `plan_required`,
`not_found`, `conflict`, `unsupported_operation`, `rate_limited`, `timeout`, `upstream_error`, `cursor_invalid`,
`response_too_large`, `unsafe_integer`, `verification_failed`, and `outcome_unknown`.

Map 401 to authentication, 403 to permission, 404 to not-found, 409 to conflict, and 429 to rate-limited.
Map definite 400 validation errors to validation with safe upstream details.
Read failures can be retryable; uncertain mutations require reconciliation, not automatic retries.
Do not turn a 404 into an empty result without an explicit documented contract.

### Rate limits

YNAB documents 200 requests per rolling hour per access token.
Read `X-Rate-Limit` when supplied and expose safe used/limit metadata.
Use `Retry-After` if supplied; do not assume that YNAB always supplies it.
Otherwise report the earliest locally known release time as an estimate, or omit the time if unknown.
Count preflight, counterpart reads, retries, and verification calls against the same quota.
Other clients may consume that token's quota; server responses override local estimates.
Cache GETs, avoid startup full exports, and use bulk writes after validation to reduce calls.

### Tool annotations

All tools use `openWorldHint:true` because they communicate with YNAB.
Read tools use `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`.
Write tools use `readOnlyHint:false` and conservative `idempotentHint:false`.
Updates, deletions, import, and transaction creation use `destructiveHint:true`; pure create tools use false.
Transaction creation can match an existing record when an import ID is supplied.
Annotations describe maximum possible effects, even when a call defaults to preview.
Annotations are client hints, not authorization. Runtime policy remains mandatory.

## Appendix 5 — Source policy

Primary API source: <https://api.ynab.com/>.
Endpoint source: <https://api.ynab.com/v1>.
Schema source: <https://api.ynab.com/papi/open_api_spec.yaml>.
MCP tools source: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>.
TypeScript SDK source: <https://ts.sdk.modelcontextprotocol.io/v2/servers/tools>.

Search results helped locate sources. This proposal's requirements and safeguards are our design decisions, not Exa-generated conclusions.
The pinned schema and source notes distinguish confirmed API facts from adapter policy and unresolved behaviour.
