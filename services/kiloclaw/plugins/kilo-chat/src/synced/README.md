# Synced wire-contract schemas

These files are **auto-generated copies** of the canonical zod schemas in
`packages/kilo-chat/src/`:

- `schemas.ts` ← `packages/kilo-chat/src/schemas.ts`
- `webhook-schemas.ts` ← `packages/kilo-chat/src/webhook-schemas.ts`
- `events.ts` ← `packages/kilo-chat/src/events.ts`

The plugin is packed as a standalone npm tarball inside the kiloclaw docker
image (no pnpm workspace available at build time), so we commit the copies
here instead of depending on the workspace package at runtime.

Keep them in sync: after editing a file in `packages/kilo-chat/src/`, run
`scripts/sync-plugin-shared.sh` from the repo root. CI checks the files are
identical.
