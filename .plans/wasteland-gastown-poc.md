# Wasteland ↔ Gastown POC Plan

## Current State

### What's Built

| Area                         | Status   | Details                                                                                                                                                                                            |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wasteland service**        | Complete | WastelandDO (config, members, credentials, connected towns, wanted board), WastelandRegistryDO, WastelandContainerDO, tRPC router (25+ procedures), container image with `wl` CLI + control server |
| **Wasteland UI**             | Complete | List/create wastelands, settings (config, DoltHub connection, credentials, connected towns, members, delete), wanted board browse/claim/post/done                                                  |
| **Gastown mayor tools**      | Complete | 4 container-side tools (`gt_wasteland_browse`, `claim`, `post`, `done`), HTTP client, worker handler routes                                                                                        |
| **Gastown wasteland client** | Complete | Typed HTTP client with service binding + HTTP fallback, mirrors all wasteland tRPC procedures                                                                                                      |
| **Container bootstrap**      | Complete | `storeCredential` → `setEnvVar` on container → `POST /wl/init` → `wl join` → ready. Env vars persisted in DO storage for cold-start recovery                                                       |
| **Town settings UI**         | Stub     | "Wasteland" section with a "Connect" button that is not wired up                                                                                                                                   |

### What's Missing (the POC gaps)

| #   | Gap                                                                                                                                                                                          | Impact                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | **Town has no wasteland state** — `TownConfigSchema` has zero wasteland fields; Town DO stores nothing about connected wastelands                                                            | Mayor tools require a `wasteland_id` param but the town doesn't know its wasteland. Mayor can't auto-discover it. |
| 2   | **No onboarding flow** — The "Connect" button in town settings is a TODO. There's no UI to collect DoltHub token, org, rig handle, upstream and bootstrap the connection from within gastown | Users have to manually create a wasteland in the separate wasteland UI, then somehow connect it                   |
| 3   | **Beads have no wasteland linkage** — No `wasteland_wanted_id` or similar field on beads. Claiming a wanted item doesn't create a bead. Closing a bead doesn't trigger `wl done`             | The whole point of the integration is absent — work in the town doesn't flow back to the wasteland                |
| 4   | **No auto-evidence on PR** — When a bead associated to a wasteland wanted item gets a PR created/merged, there's no automatic `wl done` with the PR URL as evidence                          | Manual evidence submission defeats the purpose                                                                    |
| 5   | **No UI for wasteland-linked beads** — No badge/indicator showing a bead is associated with a wasteland wanted item. No link to the upstream DoltHub PR                                      | Users can't see which work items came from the wasteland                                                          |
| 6   | **Mayor doesn't auto-know its wasteland** — System prompt doesn't include wasteland context. Mayor can't proactively browse or suggest wasteland work                                        | The mayor is blind to the wasteland unless explicitly told the wasteland ID each time                             |

## POC Scope

Focus: **Connect to Commons** — a single wasteland upstream (`hop/wl-commons`). No "create your own" flow.

### Workstreams

---

### WS1: Town DO Wasteland State

Add wasteland connection state to the Town DO so it persists across alarms and the mayor can auto-discover it.

**Schema changes** — new `town_wasteland_connections` table in Town DO SQLite:

```
town_wasteland_connections
  connection_id  TEXT PK
  wasteland_id   TEXT NOT NULL
  upstream       TEXT NOT NULL        -- e.g. "hop/wl-commons"
  rig_handle     TEXT NOT NULL
  dolthub_org    TEXT NOT NULL
  connected_at   TEXT NOT NULL (ISO)
  status         TEXT NOT NULL CHECK (status IN ('active', 'disconnecting'))
```

**Town config additions** — add to `TownConfigSchema`:

```ts
wasteland_connection?: {
  wasteland_id: string;
  upstream: string;
  rig_handle: string;
  dolthub_org: string;
}
```

**Town DO sub-module** — `services/gastown/src/dos/town/wasteland.ts`:

- `connectWasteland(sql, { wasteland_id, upstream, rig_handle, dolthub_org })`
- `disconnectWasteland(sql, wasteland_id)`
- `getWastelandConnection(sql) → connection | null`

**tRPC procedures** on gastown router:

- `connectTownToWasteland` — stores connection in Town DO, calls wasteland service `connectKiloTown`
- `disconnectTownFromWasteland` — removes connection, calls wasteland service `disconnectKiloTown`
- `getTownWastelandConnection` — returns current connection (or null)

---

### WS2: Onboarding Flow (Town Settings → Wasteland)

The Connect button in town settings opens a multi-step dialog that never leaves the gastown UI.

**Step 1: DoltHub Credentials**

- DoltHub API token (password field)
- DoltHub org / username
- Dolt credential JWK (password field, optional)

**Step 2: Rig Identity**

- Rig handle (auto-suggested from town name, e.g. `kilo-{town-name}`)
- Dolt user name (pre-filled from user profile)
- Dolt user email (pre-filled from user email)

**Step 3: Confirm & Connect**

- Shows summary: "Connecting to hop/wl-commons as `{rig_handle}` via `{dolthub_org}`"
- On confirm:
  1. Call wasteland `storeCredential` (encrypts token, pushes env vars to container, triggers `wl join`)
  2. Call wasteland `connectKiloTown` (creates town↔wasteland association)
  3. Call gastown `connectTownToWasteland` (persists in Town DO)
  4. Wait for container init to complete (poll `containerStatus`)
- Success state: "Town connected to hop/wl-commons. Agents now have access to wasteland tools. Try asking the mayor to browse the wasteland."

**After connection, the settings section shows:**

- Connected wasteland name + upstream
- Rig handle
- Disconnect button

---

### WS3: Bead ↔ Wasteland Linkage

When the mayor claims a wasteland item and creates work in the town, the resulting bead must be linked.

**Bead metadata fields** (stored in `beads.metadata` JSON):

```ts
{
  wasteland_wanted_id?: string;     // e.g. "w-abc123"
  wasteland_id?: string;            // which wasteland
  wasteland_upstream?: string;      // e.g. "hop/wl-commons"
  wasteland_evidence_url?: string;  // set when evidence submitted
  wasteland_published_at?: string;  // ISO timestamp of wl done
}
```

No schema migration needed — `metadata` is already a JSON column.

**Mayor tool update** — when `gt_wasteland_claim` succeeds, the mayor should create a bead (via sling) with the wasteland metadata attached. The claim tool response should include the wanted item details so the mayor can create an appropriate bead.

**Auto-evidence on PR** — in the bead lifecycle, when a bead with `wasteland_wanted_id` gets a PR created:

- Store the PR URL as `wasteland_evidence_url` on bead metadata
- When the bead closes (or PR merges), auto-call `wl done` with the PR URL as evidence
- This likely hooks into the existing reconciler/alarm where PR status is checked

---

### WS4: Mayor Wasteland Context

The mayor needs to know about its connected wasteland without being told each time.

**System prompt injection** — when generating the mayor's system prompt, if the town has a wasteland connection, append:

```
## Wasteland

This town is connected to the wasteland "hop/wl-commons" (wasteland ID: {id}).
You have tools to browse the wanted board, claim items, post new items, and
submit evidence of completion. When a user asks about wasteland work or
available bounties, use gt_wasteland_browse. When creating work from a
wasteland item, note the wasteland_wanted_id in the bead metadata.
```

**Tool availability** — the wasteland tools (`gt_wasteland_browse`, etc.) should only be included in the mayor's tool list when a wasteland connection exists. Currently they're always registered — gate them behind `townConfig.wasteland_connection != null`.

**Auto-populate `wasteland_id` param** — the mayor tools currently require `wasteland_id` as an explicit parameter. Since the town knows its connected wasteland, auto-fill this from town config so the mayor doesn't have to specify it.

---

### WS5: UI for Wasteland-Linked Beads

**Bead card indicator** — when a bead has `wasteland_wanted_id` in its metadata, show a small wasteland badge/icon on the bead card (e.g., a Globe icon with "Wasteland" tooltip).

**Bead detail** — in the bead detail view, if wasteland metadata exists, show:

- "Wasteland Item: {wanted_id}" (linked to the wasteland wanted board)
- Evidence status (submitted / pending)
- If there's an upstream DoltHub PR, link to it

**Town overview** — optionally, show a count of active wasteland-linked beads in the town dashboard.

---

### WS6: Wasteland Service Fixes

From issue exploration and current state:

- **Container cold-start reconciliation** — when a container wakes from sleep, the `selfInit()` already handles this via env vars persisted in DO storage. Verify this works end-to-end.
- **Dolt credential JWK** — the UI field was changed to password-masked input. Verify the credential flow works with JWK provided (needed for `dolt push` in PR-mode mutations).

---

## Implementation Order

| Phase       | Workstreams                                 | What it enables                                                                   |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| **Phase A** | WS1 (Town DO state) + WS2 (Onboarding flow) | User can connect a town to the commons from the gastown UI                        |
| **Phase B** | WS4 (Mayor context) + WS3 (Bead linkage)    | Mayor auto-knows the wasteland, claimed items become beads, completions flow back |
| **Phase C** | WS5 (UI indicators)                         | Users can see which beads came from the wasteland                                 |
| **Phase D** | WS6 (Service fixes)                         | Polish and reliability                                                            |

## Ideas from Issues

### From #1810 (Hosted Wasteland Service)

- ✅ Already implemented: per-wasteland containers, encrypted credential storage, `sleepAfter: 30m`, control server with 8 endpoints, DoltHub REST API reads from DO (no container needed for browse)
- Relevant for POC: the "hybrid read" model — browse reads from DO's DoltHub SQL API (instant, no cold start), writes go through container. Already built.

### From #1040 (Wasteland Integration — Town Side)

- **Reconciler events** (`wasteland_completion_ready`, `wasteland_published`, etc.) — good design but heavier than needed for POC. For POC, the auto-evidence can be simpler: hook into the existing PR-merge detection in the alarm loop.
- **TownConfig schema** from #1040 proposed multi-wasteland connections. For POC: single connection is sufficient. The schema should allow for future multi-connection but the UI only supports one.
- **Rig registration** details: `rig_type = 'agent'`, `parent_rig = <human-owner-handle>`, `trust_level = 1`. We should set these during onboarding. The `wl join` command handles rig registration — need to verify it accepts these fields or if we need to configure them separately.
- **`rig_links` table** — linking the agent rig to the human owner's rig. This is a nice-to-have for the POC, not blocking.
- **Sandbox fields** (`sandbox_required`, `sandbox_scope`, `sandbox_min_tier`) on wanted items — noted in bead metadata for future container env config. Not needed for POC.
- **Stale completion escalation** (published > 7d, not validated → escalation bead for mayor) — good idea, defer to post-POC.
