# Implementation plan: local YNAB MCP

Status: implementation completed; release validation is tracked in [implementation status](implementation-status.md).
Research checked on 2026-10-07. This document preserves the module contracts and implementation sequence.

### R bootstrap handoff

- Frozen `src/contracts.ts` declarations and `ToolFailure` are implemented without interface changes.
- `src/catalog.ts` exports `catalog: readonly ToolDefinition[]`, `inputValidators` and
  `outputValidators: ReadonlyMap<ToolName, ValidateFunction>`, and `loadCatalog(url?: URL): LoadedCatalog`.
  `LoadedCatalog` contains those same three fields. Validators return booleans and expose Ajv `.errors`.
  The catalog is deeply frozen, all 70 schemas compile, external references are rejected, and input
  validation never coerces values, inserts defaults, or removes fields. Output validators cover every result union.
- Strict NodeNext ESM/Node 24 tooling is installed with exact SDK 2.3.1 pins. Vitest 4.1.11
  discovers only `tests/**/*.test.ts`; `npm test -- tests/<stream>` supports focused runs.
  Lint is intentionally lean TypeScript unused-local/parameter checking, not a style formatter.
  Ajv 8.20.0 is used rather than the research version to avoid its known advisory.
- `scripts/generate-types.mjs` uses pinned openapi-typescript 7.10.1 and verifies the snapshot hash.
  H runs `npm run generate:types` to create its owned `src/ynab/types.ts`; bootstrap tests generated
  into temporary files only. Optional positional output paths are supported; generation is deterministic/offline.
- `npm run build` emits `dist/`; the loader resolves the existing catalog relative to its module,
  not cwd. `package.json` includes `docs/tool-catalog.json` in package assets.
- TDD red: `npm test -- tests/runtime/catalog.test.ts` failed because `src/catalog.js` was absent.
  Type-generation test separately failed because its script was absent. Full discovery initially
  exposed Nix input tests in `.direnv`; explicit test-root configuration fixed this.
- Green: `npm ci` (zero audit vulnerabilities), `npm run check` (typecheck, compiler lint,
  10 tests in 2 files, build, and unchanged check-spec), focused runtime tests, and a built catalog
  import from `/tmp` (35 tools / 70 validators). No `.env` was read and no YNAB requests were made.
- Server/index, config/HTTP, safety/state, handlers, transport tests, executable packaging, and
  generated upstream types are deliberately deferred; no production `start` or `bin` exists yet.

## Decision and scope

Implement all 35 catalog tools with fixture-first TDD. Keep the proposal's default core, read-only profile.
Enable all 35 only with the extended profile and the required write, delete, and import permissions.
Keep the fixed YNAB `/v1` origin, explicit plan selection, UUID allowlist, and stdio transport.
The catalog defines wire schemas; proposal Appendices 3–4 define semantic safety and verification.
Do not replace the pinned upstream snapshot or silently revise the catalog.

### Verified SDK choice

Pin **`@modelcontextprotocol/server@2.3.1`** and test dependency **`@modelcontextprotocol/client@2.3.1`** without version ranges.
Live npm registry checks returned these stable `latest` releases. Both require Node >=20.
`nix develop` supplied Node **24.21.0** and npm **11.19.0**. Both SDK packages installed successfully in a research directory.
No application dependency or lockfile was created during research.

Use `Server` from `@modelcontextprotocol/server` for the two low-level handlers.
This deliberate advanced API choice preserves the existing JSON schemas and structured validation errors.
Use `setRequestHandler('tools/list', handler)` and `setRequestHandler('tools/call', handler)`.
These handlers receive the request object and context; this is not the v1 schema-argument registration API.
Project tool results with `server.projectCallToolResult(result, tool.outputSchema)`.
Use `serveStdio` and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, with `legacy: 'serve'`.
The factory can return a low-level `Server`. No `@modelcontextprotocol/node` dependency is needed for stdio.

The installed SDK also exports `McpServer`, `fromJsonSchema`, and JSON Schema validator adapters.
Do not use its default tool error handling here: it can return text-only validation errors.
Also, its high-level output check skips `isError` results. Validate **every** envelope in our dispatcher instead.
Use Ajv2020 plus `ajv-formats`, with no coercion, inserted defaults, or field removal.
All 70 catalog schemas compiled successfully with Ajv 8.17.1 and ajv-formats 3.0.1.
An installed-SDK in-memory smoke test completed discovery and preserved our structured error envelope.

Record protocol support in README and tests, not just the package lockfile.
The installed SDK's public `LATEST_PROTOCOL_VERSION` is `2025-11-25`; its modern stdio entry also supports `2026-07-28`.
Test legacy initialization and the modern discovery exchange separately. Do not infer protocol dates from package major versions.

Sources checked directly: [npm server metadata](https://registry.npmjs.org/@modelcontextprotocol/server/latest),
[npm client metadata](https://registry.npmjs.org/@modelcontextprotocol/client/latest), and their published tarballs.
Official guides: [custom handlers](https://ts.sdk.modelcontextprotocol.io/v2/advanced/custom-methods.html),
[tools](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools), and
[SDK repository](https://github.com/modelcontextprotocol/typescript-sdk).
Exa found the official sources; the package checks and design decisions above are our own work.

## Path ownership and dependency order

Use one shared checkout **sequentially** unless the manager creates independent worktrees.
Consult the worktrunks skill before creating worktrees. Parallel workers must not share writable files.
Only the runtime owner changes root tooling, shared contracts, shared fixtures, or the dependency lockfile.
Other owners request interface changes through the manager; they do not edit another owner's paths.
Each owner keeps fixtures and tests inside its own subtree.

| Stream | Exclusive paths | Work and tool ownership |
| --- | --- | --- |
| R: runtime/integration | `package.json`, `package-lock.json`, TypeScript/test/lint configuration, `src/contracts.ts`, `src/errors.ts`, `src/catalog.ts`, `src/index.ts`, `src/runtime/**`, `scripts/generate-types.mjs`, `tests/runtime/**`, `tests/integration/**`, `tests/helpers/**`, `README.md`, `.env.example` | Bootstrap the frozen contracts, schema validation, dispatcher, stdio, executable packaging, release commands, independent integration tests, and documentation. Preserve `scripts/check-spec.mjs` and existing reference artifacts. |
| H: config/HTTP | `src/config.ts`, `src/ynab/**`, `tests/http/**` | Immutable permissions, private token loading, fixed-origin HTTP, safe paths, quotas, concurrency, errors, bounded parsing, and generated upstream types. |
| S: safety/state | `src/safety/**`, `tests/safety/**` | Policy checks, UTC/date rules, revisions and counterpart inspection, plan write locks, write lifecycle, shared bounded GET cache and frozen snapshots. |
| Q: read routes | `src/tools/read.ts`, `tests/read/**` | The 15 core read tools and both extended money-history tools: **17 tools**. Route/filter mapping, result metadata, plan-list filtering, and paging. |
| T: transaction writes | `src/tools/transactions.ts`, `tests/transactions/**` | Create/update/bulk update, approval, categorization, deletion, and bank import: **7 tools**. Split/transfer/account/category semantic checks and endpoint-specific verification. |
| M: maintenance/schedules | `src/tools/maintenance.ts`, `src/tools/scheduled.ts`, `src/tools/account-payees.ts`, `src/tools/categories.ts`, `tests/maintenance/**` | **11 tools** across three independently owned submodules: scheduled CRUD (3), account/payee creation or updates (3), and category/group creation or updates plus monthly assignment (5). `createMaintenanceTools` composes their factories; target and schedule request/response comparisons remain with each submodule owner. |

M is split into three bounded implementation workers:
- `src/tools/scheduled.ts` exports `createScheduledTools(services: Services): HandlerMap`.
- `src/tools/account-payees.ts` exports `createAccountPayeeTools(services: Services): HandlerMap`.
- `src/tools/categories.ts` exports `createCategoryTools(services: Services): HandlerMap`.

`src/tools/maintenance.ts` is the composition-only aggregator exporting the existing
`createMaintenanceTools(services: Services): HandlerMap` interface. No placeholder
implementations are supplied while the three submodule workers finish.

Order: **R bootstrap → H + S foundations → Q/T/M handlers → R integration and release**.
H and S can implement against frozen contracts independently. S tests inject a fake `YnabApi`.
Q/T/M can then work independently against injected services and fixtures.
Merge one stream at a time. Run typecheck and focused tests after each merge; run the full suite before live checks.
Independent reviewers must inspect actual requests/results and tests, not only worker summaries.

## Frozen TypeScript boundary

R creates these declarations first in `src/contracts.ts`. Use strict ESM and `.js` import specifiers.
These are cross-owner interfaces, not additional user-facing schemas.
Handlers can use generated upstream types and local input types internally.
JSON boundaries remain schema-validated; a TypeScript assertion alone never validates upstream data.

```ts
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject { [key: string]: Json }
export type ToolName = `ynab_${
  | 'get_user' | 'list_plans' | 'get_plan_settings'
  | 'list_accounts' | 'get_account' | 'list_categories' | 'get_category'
  | 'list_months' | 'get_month' | 'list_payees' | 'get_payee'
  | 'list_transactions' | 'get_transaction'
  | 'list_scheduled_transactions' | 'get_scheduled_transaction'
  | 'create_transactions' | 'update_transaction' | 'update_transactions'
  | 'set_transaction_approval' | 'categorize_transactions'
  | 'delete_transaction' | 'import_transactions'
  | 'create_scheduled_transaction' | 'update_scheduled_transaction'
  | 'delete_scheduled_transaction'
  | 'list_money_movements' | 'list_money_movement_groups'
  | 'create_account' | 'create_payee' | 'update_payee'
  | 'create_category_group' | 'update_category_group'
  | 'create_category' | 'update_category' | 'set_category_assignment'
}`;
export type MutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly profile: 'core' | 'extended';
  readonly permissions: { readonly write: boolean; readonly delete: boolean;
    readonly imports: boolean };
  readonly upstream: readonly { readonly method: 'GET' | MutationMethod;
    readonly path: string }[];
  readonly pageCollection?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly annotations: { readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean; readonly idempotentHint: boolean;
    readonly openWorldHint: boolean };
}
export interface Config {
  readonly defaultPlanId?: string;
  readonly allowedPlanIds: readonly string[] | null;
  readonly readOnly: boolean;
  readonly allowDeletes: boolean;
  readonly allowReconciledChanges: boolean;
  readonly allowImports: boolean;
  readonly toolProfile: 'core' | 'extended';
  readonly timeoutMs: number;
  readonly cacheTtlSeconds: number;
  readonly logLevel: 'error' | 'warn' | 'info';
}
export interface Clock { now(): number }
export interface CallContext {
  readonly tool: ToolDefinition;
  readonly requestId: string;
  readonly planId?: string;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}
export type ResolvedScope =
  | { kind: 'plan' } | { kind: 'account'; account_id: string }
  | { kind: 'category'; category_id: string }
  | { kind: 'payee'; payee_id: string } | { kind: 'month'; month: string };
export interface RateLimit { used?: number; limit?: number; estimated?: boolean }
export interface Meta {
  request_id: string; fetched_at: string; warnings: string[];
  plan_id?: string; resolved_month?: string; resolved_scope?: ResolvedScope;
  resolved_since_date?: string; resolved_until_date?: string;
  mode?: 'snapshot' | 'delta'; cache_hit?: boolean;
  revisions?: Record<string, string>; next_cursor?: string;
  complete?: boolean; returned_count?: number; total_count?: number;
  rate_limit?: RateLimit;
}
export type ErrorCode =
  | 'configuration_error' | 'validation_error' | 'authentication_error'
  | 'permission_denied' | 'plan_required' | 'not_found' | 'conflict'
  | 'unsupported_operation' | 'rate_limited' | 'timeout' | 'upstream_error'
  | 'cursor_invalid' | 'response_too_large' | 'unsafe_integer'
  | 'verification_failed' | 'outcome_unknown';
export interface ToolError {
  code: ErrorCode; message: string; retryable: boolean;
  outcome: 'not_applied' | 'applied' | 'unknown';
  http_status?: number; upstream?: { id: string; name: string; detail: string };
  retry_after_seconds?: number; details?: JsonObject; recovery_tool?: string;
}
export interface Preview {
  method: MutationMethod; path: string; body: JsonObject | null;
  validated: true; before: JsonObject[];
  expected_revisions: Record<string, string>; affected_ids: string[];
  unknown_effects: boolean; warnings: string[];
}
export interface OkResult { status: 'ok'; data: JsonObject; meta: Meta }
export type ToolResult = OkResult
  | { status: 'preview'; preview: Preview; meta: Meta }
  | { status: 'error'; error: ToolError; meta: Meta };
export interface ApiRequest {
  readonly method: 'GET' | MutationMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: JsonObject;
}
export interface ApiReply {
  readonly data: JsonObject; // unwrapped upstream `data`, never renamed
  readonly fetchedAt: string;
  readonly rateLimit?: RateLimit;
}
export interface CachedReply extends ApiReply { readonly cacheHit: boolean }
export interface YnabApi {
  request(ctx: CallContext, request: ApiRequest): Promise<ApiReply>;
}
export interface Connection { readonly config: Config; readonly api: YnabApi }
export type EntityRef =
  | { kind: 'transaction' | 'scheduled_transaction' | 'payee'
      | 'category' | 'category_group'; id: string }
  | { kind: 'category_assignment'; id: string; month: string };
export interface Inspection {
  readonly ref: EntityRef;
  readonly entity: JsonObject;
  readonly counterparts: readonly JsonObject[];
  readonly revisionKey: string;
  readonly revision: string;
  readonly source: CachedReply;
}
export interface WriteTarget {
  readonly ref: EntityRef;
  readonly expectedRevision?: string;
}
export interface PreparedWrite {
  readonly method: MutationMethod;
  readonly path: string;
  readonly body: JsonObject | null;
  readonly warnings: readonly string[];
  readonly unknownEffects: boolean;
  readonly setsReconciled: boolean;
  readonly usesImportId: boolean;
  readonly resolvedMonth?: string;
}
export interface VerifiedWrite {
  readonly data: JsonObject;
  readonly warnings: readonly string[];
  readonly revisions?: Readonly<Record<string, string>>;
  readonly fetchedAt?: string;
}
export interface WriteSpec {
  readonly targets: readonly WriteTarget[]; // empty for creates/import
  prepare(current: readonly Inspection[]): Promise<PreparedWrite>;
  verify(reply: ApiReply, prepared: PreparedWrite,
    before: readonly Inspection[]): Promise<VerifiedWrite>;
}
export interface SafetyState {
  resolvePlan(explicit?: string): string;
  available(tool: ToolDefinition): boolean;
  assertAvailable(tool: ToolDefinition): void;
  get(ctx: CallContext, path: string,
    query?: ApiRequest['query'], bypassCache?: boolean): Promise<CachedReply>;
  meta(ctx: CallContext, source?: CachedReply): Meta;
  inspect(ctx: CallContext, ref: EntityRef): Promise<Inspection>;
  revision(ctx: CallContext, ref: EntityRef, entity: JsonObject,
    counterparts?: readonly JsonObject[]): string;
  page(ctx: CallContext, args: JsonObject, collection: string,
    fetchFirst: () => Promise<OkResult>): Promise<OkResult>;
  write(ctx: CallContext, args: JsonObject, spec: WriteSpec): Promise<ToolResult>;
  invalidatePlan(planId: string): void;
}
export interface Services {
  readonly config: Config; readonly api: YnabApi;
  readonly state: SafetyState; readonly clock: Clock;
}
export type ToolHandler = (args: JsonObject, ctx: CallContext) => Promise<ToolResult>;
export type HandlerMap = Readonly<Partial<Record<ToolName, ToolHandler>>>;
```

Freeze these module exports as well:

```ts
// src/config.ts; token remains private inside api, absent from Config/Services.
export function createConnection(
  env: Readonly<Record<string, string | undefined>>,
  options?: { fetch?: typeof globalThis.fetch; clock?: Clock }
): Promise<Connection>;
// src/ynab/client.ts; path includes /plans/<UUID>, but not /v1.
export function planPath(planId: string, ...segments: string[]): string;
// src/safety/index.ts
export function createSafetyState(config: Config, api: YnabApi,
  clock?: Clock): SafetyState;
// src/safety/dates.ts; UTC only, invalid input throws ToolFailure.
export function assertCalendarDate(value: string): void;
export function resolveReadMonth(value: string, nowMs: number): string;
export function assertTransactionDate(value: string, nowMs: number): void;
export function assertScheduledDate(value: string, nowMs: number): void;
export function oneYearAgo(nowMs: number): string;
// Each tool file exports its own factory: read / transactions / maintenance.
export function createReadTools(services: Services): HandlerMap;
export function createTransactionTools(services: Services): HandlerMap;
export function createMaintenanceTools(services: Services): HandlerMap;
// src/errors.ts; implementation owned by R, imported by all workers.
export declare class ToolFailure extends Error {
  readonly error: ToolError;
  constructor(error: ToolError);
}
// src/runtime/server.ts
export function createServer(connection: Connection, clock?: Clock):
  import('@modelcontextprotocol/server').Server;
```

### Boundary rules

- `createConnection` accepts exactly one token source. Enforce file ownership/mode rules and strict configuration parsing.
  Never inspect `.env` during development. Do not put tokens in shared config, arguments, diagnostics, or exceptions.
- H owns HTTPS, at most two concurrent requests, rolling quota accounting, and per-request aborts.
  Reject normalized path escape and redirects. Allow unscoped GET only for `/user` and `/plans`.
  A scoped request must remain inside `ctx.planId`. All waits and retries obey its 60-second deadline.
  Bound upstream response bytes to 8 MiB before full JSON decoding.
  Parse JSON numbers without silent unsafe-integer rounding; do not mistake display currency decimals for integer fields.
  Retry GET at most twice; never retry mutations. Return safe errors via `ToolFailure`.
- S owns the single 64 MiB cache/snapshot budget. The API itself does not cache.
  Cache keys include this connection's private identity, plan, path, and normalized query.
  Tool handlers use `state.get`, not direct GET calls. Preflight and verification always bypass caches.
- `inspect` always performs fresh detail reads. For transactions it fetches the complete linked counterpart graph.
  Use visited IDs; include split-transfer counterparts. Fail before mutation if the graph cannot be inspected completely.
  Group inspection uses full, non-delta categories. Assignment inspection uses the exact month-category endpoint.
  `revision` applies the proposal's canonical projections, context, null normalization, and child-ID ordering.
  Assignment revision keys are `category:<id>:<month>`; ordinary keys use the proposal's entity kind.
- Read handlers can use `inspect` for revision-bearing details. Emit group revisions only from full categories snapshots.
  Never issue transaction revisions from lists, hybrid rows, or deltas.
- `page` validates/binds the original selectors and page size before invoking `fetchFirst`.
  A valid continuation returns saved data/meta without invoking that callback or resolving dates again.
  First-fetch normalization lives inside the callback. Preserve whole nested arrays and source timestamps.
  Give each continuation its own request ID while retaining the source `fetched_at`.
  Page only the catalog's primary collection. Honor five-minute expiry and the 512 KiB result bound.
- `write` owns the per-plan lock from fresh inspection through verification, including preview preparation.
  It checks availability, revisions, overlapping target graphs, reconciled states, delete confirmation, and import permission.
  It calls `prepare` only after inspection; `prepare` performs endpoint-specific semantic checks.
  Check `setsReconciled` and `usesImportId` even for previews. Match the prepared operation to catalog endpoint metadata.
  A preview never invokes `api.request` with a mutation. It returns the inspected state, revisions, and affected IDs.
  After preparation, execution freshly re-inspects every target graph immediately before submission.
  Reject any changed revision, including changes during preparation. Do not rebuild intent or refresh revisions silently.
  Submit one mutation, then invalidate the plan's GET cache and snapshots, including on ambiguous failure.
  Invoke `verify` once after acknowledgment; return its observed timestamp/revisions and any prepared month context.
  Verification failures report `outcome: applied`; uncertain application reports `unknown`.
  Never retry or roll back a mutation. Include safe acknowledged IDs and the appropriate recovery read tool.
- T/M own field-level semantics and comparisons in `prepare`/`verify`. They use `state.get(..., true)` for authoritative verification.
  Compare bulk results by ID or validated multisets, never by input/output array position.
  Inspect transfer counterparts again after a write; report verification gaps rather than inventing effects.
- R validates inputs before dispatch, preserving omission versus null. It resolves the plan once and builds `CallContext`.
  Apply availability checks to direct calls as well as discovery. Known hidden tools return structured permission errors.
  Validate all output unions, including errors, and add one short text block plus `isError` for error status.
  Do not leak unexpected exception text. Bound arguments to 1 MiB before validation, and all tool results to 512 KiB.
  Bound the stdio buffer separately, allowing protocol overhead. Log only tool/status/duration/request ID to stderr.

## TDD and independent success checks

Start each rule with a failing test, implement it, then run focused tests and typecheck.
Use artificial fixture IDs, financial text, and a fake token sentinel. Automated tests must not inherit real credentials.
No normal test command may call YNAB. Tests inject `fetch`/`YnabApi`; never add a production base-URL environment override.
R supplies small scripted-fetch helpers first. Other streams can also use local stubs without editing shared helpers.
Keep route fixtures independent from code under test; do not calculate expected requests with production route builders.

Required checks:

1. **Catalog:** exactly 35 names, 25 core and 10 extended; compile all 70 schemas; validate sample envelopes.
   Preserve snapshot hash and existing `node scripts/check-spec.mjs` checks.
2. **HTTP/config:** missing/conflicting/empty token; invalid token file; strict booleans and UUIDs;
   hostile IDs; wrong-plan requests; redirects; timeout; response limits; unsafe integers;
   401/403/404/409/429; rolling quota; two-request concurrency; safe logging; no mutation retry.
3. **Policy/state:** defaults and direct-call gates; filtered plans and `default_plan`;
   fresh revision reads, including changes during preparation; canonical hash fixtures; counterpart cycles and overlapping batches;
   cache bypass/invalidation; cursor mismatch/expiry/eviction; UTC midnight and leap dates;
   item-boundary page shortening; whole split/group rows; delta tombstones; zero-item success.
4. **All tools:** one positive request/response fixture per tool, validated against catalog output;
   exact verb/path/query/body; one negative case; every mutation gets preview **and** execution fixtures.
   Default previews and denied calls must produce zero mutation requests.
5. **Transactions:** approval changes only `approved`; categorization preserves approval;
   omission/null handling, payee selector coupling, create defaults, batch validation before any write;
   split totals with safe arithmetic, immutable existing split rows, transfer/account rules,
   reconciled counterpart protection, import duplicates and zero imports, unknown/partial outcomes.
6. **Maintenance:** all schedule frequencies; future-date window; date/date_next mapping;
   omitted optional schedule fields and payee clearing; scheduled split protection;
   group/payee/category preflight; transfer-payee rename rejection; absolute assignments;
   target removal, NEED rollover/frequency mappings, and loan/Credit Card Payment exclusions.
7. **Transport:** spawn the built entry through the official client; initialize, discover, call, and close.
   Use a test-only entry with injected fake services, not production `.env` or an alternate host setting.
   Test legacy and modern exchanges, exact catalog schemas, structured errors, and protocol-only stdout.
   `--help`/`--version` must work without a token. EOF and signals must terminate cleanly.

Independent gates after handler merges:

- A validation worker derives endpoint assertions from the pinned YAML and catalog, not handler summaries.
- A safety reviewer inspects previews, stale writes, counterpart traversal, unknown outcomes, and secrets in captured output.
- R runs all 35 fixture calls through the dispatcher and SDK client. Mere registration does not count as coverage.
- Release requires `npm ci`, `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`, and `npm run check:spec`.
  `npm start` runs the built stdio entry. Add a package `bin` with a Node shebang and include required catalog assets.
  Generate upstream TypeScript types deterministically from the pinned YAML; keep stricter catalog inputs separate.

## Spec issues and practical gates

No decision blocks fixture implementation. The following rules prevent unsafe guesses:

- **Recurring targets:** establish independently reviewed request/response fixtures before enabling `goal_frequency` execution.
  Compare NEED type, amount, cadence monthly=1 / weekly=2 / yearly=13, and cadence frequency=1.
  Establish fixtures for null removal and supported rollover/date behavior too.
  A schema-valid save alone does not prove these fields took effect.
- **Schedules:** prove write `date` versus read `date_next`, all frequencies, and selector merging with fixtures.
  Reject unsupported combinations before POST/PUT. Gate a disputed combination, not unrelated tools.
- **Loan/category identity:** the category response does not provide a simple writable loan selector.
  Use documented account/category relationships, group context, and DEBT state conservatively.
  If context cannot prove a requested target operation safe, reject it with `unsupported_operation`.
- **Money movements:** pinned routes omit delta inputs; do not add them from narrative documentation.
- **Optimistic revisions:** disclose the upstream race after preflight; no fabricated CAS or atomic bulk guarantee.
- **Scope:** this authorization covers feasible public API operations only. Unsupported split edits, scheduled split creation,
  category/account deletion, hidden UI operations, and remote listeners remain excluded.

## Controlled live test limits

Live tests are separate and opt-in. The manager performs them only after all independent fixture gates pass.
Use only the configured **test plan**, not a discovered plan, `last-used`, or another account owner's working plan.
The harness must require an explicit test-plan UUID and require a singleton matching allowlist.
It must fail closed if the configured default or selected plan differs. Do not print the environment or token.
Read existing test entities to confirm context before any mutation.

Default live allowance: **at most 30 GET requests and 5 mutation requests**, with one scratch ordinary transaction.
Use an existing unlinked, non-reconciled test account and ordinary non-deleted category.
Choose an amount with absolute value at most 1000 milliunits; use no import ID, transfer, split, or new payee name.
The five requests are create unapproved/uncleared, update memo, categorize, approve, and delete the scratch transaction.
Use a unique test marker, fresh revisions, verified results, and enabled deletion only for cleanup of that exact ID.
Inspect the transaction after each change. Record only safe operation summaries and scratch IDs, never tokens or full payload logs.
On timeout or unknown outcome, stop mutations and reconcile with reads. Do not replay the request or exceed the limit.
If cleanup cannot finish safely, report the remaining scratch ID instead of broad deletion.

Do not live-test imports, matching, reconciliation, transfers, account creation, or category/group/payee creation by default.
The public API cannot clean up several maintenance creates. Target/assignment/schedule live experiments need a separate bounded run plan.
Fixture coverage of all 35 tools does not require live mutation coverage of all 35 tools.

## Launcher and remaining decisions

README must explicitly load `.env` in the **launcher**, not server code. Example MCP arguments:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "--env-file=/absolute/path/to/ynab-mcp/.env",
    "/absolute/path/to/ynab-mcp/dist/index.js"
  ]
}
```

Also document token-file launch, singleton plan allowlists, core/extended profiles, default read-only behavior,
host approval of exact execution arguments, hosted-model privacy, and unknown-outcome recovery.
Never show a real token or instruct the agent to open `.env`.

Remaining operational decisions: confirm the test-plan UUID and suitable existing account/category through safe tool reads;
confirm scratch cleanup permission before the live run. No new product choice or unattended-write policy is required.
Keep core/read-only defaults despite implementing all feasible tools. The host remains responsible for execution approval.
