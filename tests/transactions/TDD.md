# Transaction stream TDD evidence

All commands used `nix develop --command`; API fixtures inject a fake YnabApi into the real safety state and dispatcher. Expected request literals were derived from proposal Appendix 3, catalog inputs, and pinned OpenAPI SaveTransaction/SaveSubTransaction/response wrappers, independently of handler builders.

- Initial red: `npm test -- tests/transactions` failed to import absent `src/tools/transactions.js` (2026-10-07, 08:41 run).
- Initial green: all 40 transaction fixtures passed after implementation.
- Graph disclosure red: 54 fixtures, 1 failure; successfully inspected counterpart `tx-2` was not reported in warnings. Implemented observed counterpart summaries; green.
- Additional invariant red: 61 fixtures, 4 failures; existing splits could move into tracking/on-budget transfers, approval accepted deleted targets, and create acknowledgments without transfer links did not disclose gaps. Added checks/disclosures; green.
- Fresh authority red: 63 fixtures, 1 failure; fresh transfer detail contradicted the acknowledged memo but returned success. Added fresh requested-field verification; green.
- Timestamp red: 64 fixtures, 1 failure; IDs-only verification used save timestamp instead of authoritative GET timestamp. Propagated observed timestamp; green.

Coverage: seven main tools each have exact preview and execution fixtures plus denied policy fixture; previews mutate zero times. Additional fixtures cover upstream-ignored intent, partial IDs, missing entities, reordered bulk responses/create and split multisets, null/omitted payees, unrelated approval/category fields, safe split totals, transfer context/graphs/overlaps, opaque import effects/duplicates/empty IDs, revisions, deletion acknowledgment contradictions, and ambiguous/no-retry outcomes. Every fixture call asserts its catalog output schema.

Frozen shared limitation (reported to manager): catalog accepts opaque transaction ID `bank:fixture`, but `src/ynab/client.ts` planPath and HTTP path guard only accept `[A-Za-z0-9_-]+` segments. Offline repro: inputValidators.get('ynab_update_transaction')({transaction_id:'bank:fixture',changes:{memo:'test'}}) returns true; planPath(planUUID,'transactions','bank:fixture') throws validation_error. Safety uses URI encoding, so HTTP must safely accept/decode/re-encode catalog-valid opaque transaction IDs while continuing to reject escape/control characters. No shared files were changed.
