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

---

## Bead 2: UI (CreateBeadDrawer + MDXEditor)

### Status: in progress

### Deviations from plan

- The `createBead`, `startBead`, and `enrichBead` procedures from bead 0/1 were NOT yet reflected in `apps/web/src/lib/gastown/types/router.d.ts`. Added them manually to the declaration file (both the top-level `gastawnRouter` section and the nested `wrappedGastawnRouter` section).
- Used `@mdxeditor/editor` with a dynamic import wrapper. The MDXEditor CSS import must be in the non-SSR wrapper file (not the parent component) to avoid Next.js SSR issues.
- MDXEditor dark theme: overriding via CSS variables on the container element is the cleanest approach since the library doesn't natively support dark mode out of the box.
- Debounce for AI enrichment is implemented with `useEffect` + `setTimeout`/`clearTimeout` rather than a library like `use-debounce`, since that would be a new dependency.

### Notes for future implementors

- MDXEditor requires `ssr: false` dynamic import in Next.js. The `MarkdownEditor.tsx` wrapper imports the CSS and renders MDXEditor directly; the parent uses `dynamic(() => import('./MarkdownEditor'), { ssr: false })`.
- The `CreateBeadDrawer` uses `vaul` `Drawer.Root` (same pattern as `BeadDetailDrawer`) for the right-side slide-in.
- AI enrichment fires on body text > 20 chars after a 1500ms debounce. `userEditedTitle` state prevents AI overwriting manual title changes.
- Labels from `enrichBead` are shown as `✨` chips. The user can remove them. Custom label entry via a text input "+ add" pattern.
- `startImmediately=false` (default): bead gets `gt:held` label and mayor is notified. `startImmediately=true`: bead is created and dispatched immediately.

---

## Bead 3: Mayor system prompt

### Status: completed

### Deviations from plan

- `notifyMayorOfNewBead()` was already partially implemented by bead 1 (with a slightly different message). Updated the message to match the spec exactly (adding the `To start the bead immediately, remove the gt:held label via gt_bead_update.` line and the `When you reply, create a message bead` instruction using the exact wording from the bead spec).
- The mayor system prompt lives in `services/gastown/src/prompts/mayor-system.prompt.ts` — a standalone file exporting `buildMayorSystemPrompt()`. Added the new `## User-Created Beads` section at the end, before the closing backtick.
- `gt_bead_update` in `mayor-tools.ts` already exposed both `labels: string[]` and `body: string` — no changes needed there.

### Notes for future implementors

- The mayor system prompt is in `services/gastown/src/prompts/mayor-system.prompt.ts`, NOT inline in `Town.do.ts`. It's called via `dispatch.systemPromptForRole()` which calls `buildMayorSystemPrompt()` from `container-dispatch.ts`.
- `sendMayorMessage()` in `Town.do.ts` sends a message to the mayor's running container via the kilo API. It's called from `notifyMayorOfNewBead()` after a user creates a held bead.
- `gt_bead_update` (mayor-tools.ts:294) already has both `labels` and `body` parameters — no changes needed.
- The mayor sees the notification message as a user turn. It should respond by calling `gt_sling({ type: 'message', parent_bead_id: beadId, body: '...' })` to post its response back to the bead drawer.
