# YNAB API research baseline

Retrieved: 2026-10-07. No authenticated YNAB requests were made.

## Source snapshot

- Official schema URL: <https://api.ynab.com/papi/open_api_spec.yaml>
- File: [ynab-openapi-1.87.0.yaml](ynab-openapi-1.87.0.yaml)
- OpenAPI version: 3.1.1.
- YNAB specification version: 1.87.0.
- Base URL: `https://api.ynab.com/v1`.
- SHA-256: `69411d596ee4b6f79720615038ac9cdfea43875013ca9d0e5d235ba505ebf26f`.

The YAML is an unchanged upstream reference, not our authored API.
The version number describes the specification release; it does not change the `/v1` route.
The tool catalog normalizes legacy `nullable` annotations into JSON Schema unions.
It also applies stricter adapter inputs and safe-integer bounds.

## Primary sources reviewed

1. [API overview and changelog](https://api.ynab.com/).
2. [Endpoint reference](https://api.ynab.com/v1).
3. [Personal access tokens](https://api.ynab.com/#personal-access-tokens).
4. [OAuth applications](https://api.ynab.com/#oauth-applications).
5. [OAuth security parameters](https://api.ynab.com/#oauth-authorization-parameters).
6. [Default plan selection](https://api.ynab.com/#oauth-default-plan).
7. [Delta requests](https://api.ynab.com/#deltas).
8. [Rate limiting](https://api.ynab.com/#rate-limiting).
9. [Money and date formats](https://api.ynab.com/#formats).
10. [API terms](https://api.ynab.com/#terms) and [OAuth data policy](https://api.ynab.com/#oauth-requirements).
11. [Support FAQ](https://support.ynab.com/en_us/the-ynab-api-an-overview-BJMgQ3zAq).
12. [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
13. [Official TypeScript SDK tools guide](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools).

Web search located primary sources. The proposal is our synthesis of those sources, not Exa's synthesized answer.

## Findings that affect implementation

### Authentication and privacy

PATs suit one owner. They do not expire automatically, but the owner can revoke them.
PAT read-only enforcement belongs to our adapter; do not assume a restricted PAT scope.
Use OAuth for a distributed application serving other users.
YNAB documents OAuth read-only access or normal access, not fine-grained transaction scopes.

Authorization-code OAuth supports PKCE S256. The documented token request still requires the client secret.
Access tokens currently expire after two hours. Use returned expiry data.
The docs do not promise a particular refresh-token lifetime or rotation guarantee.
New OAuth apps start with 25 external-user access tokens; public approval is a separate process.
Default-plan selection is not a per-plan authorization boundary.

Local execution does not keep returned financial data local if the agent uses a hosted model.
Never disclose the token to the model provider. Review YNAB terms before distributing a hosted or multi-user integration.

### Naming and release changes

- v1.79.0, 2026-03-05: `/plans` replaces documented `/budgets` routes and their response keys.
- Old budget routes remain backward compatible, but they use old wrapper keys.
- The proposal uses `plan`, `plan_id`, `plans`, and `default_plan`; no compatibility alias is needed.
- Existing fields `on_budget`, `budgeted`, and `to_be_budgeted` retain their API names.
- v1.82.0 adds display-formatted and decimal currency response fields.
- v1.85.0 introduces the one-year default transaction history window and `until_date`.
- v1.86.0 adds recurring target frequency writes.
- v1.87.0, 2026-09-17: loan-linked DEBT targets remain DEBT when updating target amounts.

Generated SDKs and examples can lag these changes. Validate them against the pinned schema.

### Transactions

The API supports ordinary transaction CRUD, approval, clearing state, bulk create/update, and available bank imports.
Category/payee lists return hybrid rows, which can represent subtransactions.
Transaction IDs are strings and must not be universally constrained to UUIDs.
Pending bank transactions do not appear in ordinary transaction lists.

Existing split rows cannot be changed. Changes to their parent amount/date are ignored.
Split category changes are unsupported. Credit Card Payment categories are ignored when supplied for ordinary categorisation.
Do not trust HTTP success alone when a requested field can be ignored.

Use transfer payees to create transfers. YNAB manages linked records.
The docs do not fully specify every counterpart mutation effect. Inspect results instead of inventing guarantees.
Setting `cleared=reconciled` is not a complete UI reconciliation operation.

Import IDs are account-scoped, at most 36 characters, and affect matching semantics.
Matching can pair an imported transaction with a user-entered record on the same account and amount within ±10 days.
Two imported transactions do not match each other according to the FAQ.
The schema does not guarantee that opaque matching preserves reconciled records.
Gate import/matching operations separately; protect explicit target graphs without claiming complete control over YNAB matching.
Do not automatically add import IDs to ordinary creates as generic retry keys.

Scheduled CRUD uses separate endpoints. Scheduled dates must be in the future, within five years.
Scheduled splits cannot be created through the public API.

### Categories, monthly assignments, and accounts

Monthly assignment writes set absolute `budgeted` values, not increments or available balances.
Money movement history is read-only. No atomic category-to-category move write exists.
Category/group create and update exist. Hide/delete/reorder operations are absent from the pinned paths.
Account creation supports checking, savings, cash, creditCard, otherAsset, and otherLiability.
The schema lists more account types for reads than for creates.
Plan settings writes, plan creation/deletion, account edits/deletion, and bank connection management are absent.

Target writes support amount, target date, supported NEED rollover behaviour, and supported recurring frequency.
They do not expose every target-editor setting. For loan-linked categories, only `goal_target` changes the monthly payment amount.
Future-month NEED underfunding values can differ from the UI. Do not claim exact UI report parity.

## Documentation differences and verification gates

| Difference | Decision for this proposal |
| --- | --- |
| Support FAQ says quota resets every clock hour; API docs specify a rolling hour | Follow the API reference: 200 calls per rolling hour per token |
| v1.73.0 removes `X-Rate-Limit` from 429 responses | Read the header when present; never depend on it after throttling |
| No guaranteed `Retry-After` behaviour | Respect it if present; otherwise give only labelled estimates |
| Narrative delta docs include money movements; endpoint schemas omit `last_knowledge_of_server` | Do not expose that input for money-movement tools yet |
| Category write prose mentions `goal_type`; write schema has no such property | Do not expose `goal_type` as writable |
| Some OpenAPI 3.1 schemas retain `nullable:true` | Normalize to explicit JSON Schema null unions |
| NewTransaction's generated schema does not require fundamental fields | Require account, date, and amount locally |
| Scheduled writes require only account/date upstream | Require amount/frequency locally for explicit intent |
| No documented conditional-write contract | Re-read and compare revisions; disclose the remaining race window |
| No documented bulk atomicity guarantee | Do not promise rollback; reconcile uncertain results |
| Filtered deltas may omit entities that stopped matching | Refresh filtered queues fully; keep scope-specific checkpoints |

These gates require contract tests or YNAB clarification, not experiments against the owner's production data.

## Refresh procedure

Fetch the official schema to a new versioned file. Record its version, retrieval date, and SHA-256.
Review changed paths, write fields, response wrappers, and the changelog.
Update the proposal, catalog, fixtures, and generated types together.
Do not silently replace this snapshot while retaining the old tool contract.
