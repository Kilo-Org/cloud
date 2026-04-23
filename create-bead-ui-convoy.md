# Create Bead UI Convoy — Shared Context

## Bead 1: Backend (createBead tRPC + Workers AI enrichment)

### Status: completed

### Deviations from plan

- `HELD_LABEL` and `HELD_LABEL_LIKE` constants are exported from `patrol.ts` (not alongside `TRIAGE_LABEL_LIKE` in reconciler.ts — that's just the consumer). This matches the existing pattern where `TRIAGE_LABEL_LIKE` is defined in `patrol.ts` and imported in `reconciler.ts`.
- Labels in the database are stored as JSON arrays (e.g. `'["gt:held","bug"]'`), so `HELD_LABEL_LIKE` uses the pattern `%"gt:held"%` (with quotes), matching the same pattern used by `TRIAGE_LABEL_LIKE = '%"gt:triage-request"%'`.
- `slingBead()` already supports `labels?: string[]` in its input type — no change needed there. The `sling` tRPC procedure needed updating to accept `labels` and pass it through.
- The `enrichBead` procedure uses `ctx.env.AI.run(...)`. The AI binding is typed as `Ai` (Cloudflare Workers AI SDK) in `worker-configuration.d.ts`. The `run()` call for text generation models returns `{ response?: string }`.
- `createHeldBead` and `notifyMayorOfNewBead` are added as public RPC methods on `TownDO` (not private helpers), since they need to be called from the tRPC router via `townStub`.
- For `startBead`, the labels are updated via `beadOps.updateBeadFields()` — filtering out `gt:held`. Then `escalateToActiveCadence()` is called to arm the alarm.

### Notes for future implementors

- The `createBead` tRPC procedure creates an `open` bead with `gt:held` label (unless `startImmediately=true`). The reconciler's Rule 1 excludes beads with `gt:held` label from dispatch.
- The `startBead` tRPC procedure removes `gt:held` from labels and arms the reconciler alarm via `townStub.startHeldBead()`.
- The `enrichBead` procedure calls Workers AI (`@cf/meta/llama-3.1-8b-instruct`) to suggest title + labels. It returns `null` if the AI response is unparseable.
- All three new tRPC procedures follow the `gastownProcedure` pattern with `verifyRigOwnership` (createBead, startBead) or `verifyTownOwnership` (enrichBead) for authorization.
- The mayor is notified via `townStub.notifyMayorOfNewBead()` when `startImmediately=false`.
