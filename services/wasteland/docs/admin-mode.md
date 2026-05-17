# Admin Mode

How "admin mode" — direct upstream writes, accept/reject controls, PR
management — is gated and surfaced in the wasteland.

Companion docs:

- [`wl-cli-reference.md`](./wl-cli-reference.md) — the `wl` CLI semantics
  the SDK ops are modeled on
- [`e2e-testing.md`](./e2e-testing.md) — verification playbooks

## Mental model

Two orthogonal concepts drive everything in this area:

1. **Wasteland governance** (owner / maintainer / contributor) — who can
   add members, change config, delete the wasteland. Stored on
   `wasteland_members.role`. This is about the wasteland DO record and
   doesn't touch DoltHub.

2. **Upstream authority** (`is_upstream_admin: boolean`) — whether the
   user's stored DoltHub token has push access to the upstream repo.
   This is what unlocks "admin mode": direct pushes, PR merge controls,
   accept/reject/close (rather than only being able to submit fork PRs).

They are independent. A user can:

- Own a wasteland record pointing at `hop/wl-commons` without owning
  that DoltHub repo → owner role, `is_upstream_admin=false`.
- Create a wasteland for a DoltHub repo they own → owner role,
  `is_upstream_admin=true`.
- Be a contributor on a wasteland whose DoltHub repo they also happen
  to own → contributor role, `is_upstream_admin=true` (unusual but
  valid).

We use **explicit user attestation** ("I own this upstream" checkbox)
instead of probing DoltHub for push rights, because:

- DoltHub probing requires an extra API call on every auth event.
- Probing can race with permission changes.
- The user is the source of truth for their own claim. If they're wrong,
  the first direct-push attempt fails loudly with a DoltHub 403.

A separate `verifyUpstreamAdmin` tRPC procedure exists for an explicit
"test admin access" button — useful when a user toggles the flag and
wants confirmation before attempting a real mutation.

## Where admin mode plugs in

- Credential row: `is_upstream_admin` column (`0 | 1`) on
  `wasteland_credentials`.
- `loadSdkContext` in `src/wanted-board/wanted-board-ops-sdk.ts`
  surfaces `isUpstreamAdmin` to the SDK ops layer.
- The current SDK has no upstream-direct write path. `direct: true` on
  mutation procedures (`claim`, `post`, `done`, `accept`, `reject`,
  `close`) is accepted for forward compatibility and silently downgraded
  to PR mode. See the comments in `wanted-board-ops-sdk.ts` for details.
- Admin-only procedures: `setUpstreamAdmin`, `createUpstream`,
  `verifyUpstreamAdmin`, `mergeUpstreamPR`, `closeUpstreamPR`,
  `commentOnUpstreamPR`, `setUpstreamRigTrust`. Each is gated either on
  ownership of the wasteland or on `is_upstream_admin=true`, depending
  on what the operation requires.

## UI surfaces

- **Connect / Create flow** — `apps/web` settings entrypoints split
  "Join an existing wasteland" from "Create your own". The Create flow
  pre-checks the admin box; the Join flow defaults it to off.
- **Wanted board** — admin-only buttons (accept / reject / close /
  unclaim-others) are gated on `is_upstream_admin` from
  `getCredentialStatus`.
- **Settings** — admin section shows pending PRs, an
  "I own this upstream" toggle, and rig trust management when admin.
