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
