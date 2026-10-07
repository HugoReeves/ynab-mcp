# Category comparison fixtures

These tests use the real `SafetyState` and dispatcher with a fake `YnabApi`.
They use no token, environment file, network connection, or live plan.
`src/tools/categories.ts` exports only `createCategoryTools(services)`.
The runtime owner must compose this factory in the maintenance aggregator.

## Pinned evidence

The source contract is `docs/reference/ynab-openapi-1.87.0.yaml`.
`SaveCategory` documents amount, date, NEED rollover, and frequency writes.
`CategoryBase` documents the corresponding read fields.
Proposal Appendix 3 and Appendix 4 define the semantic rules and verification.

`fixtures.ts` contains representative read responses, not recorded live responses.
Each frequency response passes the frozen catalog output schema before execution.
The fake API returns read-side fields, not a copied `goal_frequency` input.

| Write intent | Compared read fields |
| --- | --- |
| Monthly frequency | NEED, requested amount, cadence 1, cadence frequency 1 |
| Weekly frequency | NEED, requested amount, cadence 2, cadence frequency 1 |
| Yearly frequency | NEED, requested amount, cadence 13, cadence frequency 1 |
| Amount | Exact `goal_target`, active target; preserve known type unless frequency replaces it; new ordinary NEED / confirmed payment-group MF / authoritative DEBT |
| Removal | Absent/null `goal_target` and `goal_type` |
| Date | Exact `goal_target_date`, including null clearing |
| NEED rollover | Active NEED with numeric `goal_target` and exact boolean `goal_needs_whole_amount` |
| Assignment | Exact absolute `budgeted` in the explicit month |

Frequency requires a supplied non-null amount and excludes a date field, including null.
Loan targets permit only amount changes among target fields.
Credit Card Payment targets reject frequency and NEED rollover.
Existing non-NEED goals reject rollover unless frequency replaces the goal.
Missing or deleted groups and internal destinations fail before mutation.
Hidden categories and groups produce warnings.

## Explicit limitation

The pinned write schema permits null NEED rollover, but its prose defines only boolean effects.
There is no established null-to-read mapping.
The handler rejects this form with `unsupported_operation`; it does not disable the tool.
Use true for Set Aside or false for Refill.
Date/rollover edits without an existing or supplied target amount also fail explicitly.

The pinned Account schema has no category-link ID.
Existing DEBT target type supplies the authoritative loan restriction.
Payment-group context and matching credit-card/loan account names supply conservative restriction hints.
Name hints never select write IDs or assert a proven link or default DEBT type.
Loan-name-only context with a missing target blocks target mutations before submission
with `unsupported_operation` / `not_applied`; it never guesses NEED or DEBT.
Restrictions check both current and submitted names and current and destination groups.
Validated target-type expectations are retained for both acknowledgments and fresh create candidates.

## Verification and test history

Each of the five routes has schema-valid preview, execution, negative, and absent-entity tests.
Tests assert exact mutation method, path, wrapper, and body.
Tests check stale/missing revisions, target mismatches, omission preservation, and month-specific revisions.
Acknowledged mismatches return `verification_failed` with `outcome: applied`; no write repeats.

An absent update entity triggers a fresh inspection of the exact target reference.
An absent create entity triggers a fresh full list.
Only one new matching ID can verify the create; ambiguous or absent matches fail verification.
No existing same-name entity can verify a create.

The first executable red run used an empty factory: 39 tests failed.
After implementation, 59 tests passed.
Additional safety tests then exposed three failures: inactive targets and two context bypasses.
The initial correction passed all 64 original category tests.
The independent suite then exposed six false-success regressions in rollover and default target types.
After active NEED verification, retained type context, and stronger loan-hint preflight coverage,
all 117 category tests pass (including ordinary/payment/confirmed DEBT positives and create fallbacks).

Root typecheck remains blocked by a separately owned scheduled-test fixture typing error
(`tests/scheduled/scheduled.test.ts:158`). No live API validation was performed;
these checks establish fake-API behavior against the pinned contract only.
