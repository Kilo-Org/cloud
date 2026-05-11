/**
 * Pure helpers for the wasteland → bead bridge. Kept out of the
 * `wasteland-tools.handler.ts` module so unit tests can import them
 * without pulling in the Durable Object runtime (which transitively
 * requires `cloudflare:workers` and breaks pure-Node Vitest).
 */

/**
 * Pick a local gastown `rig_id` for a wasteland-originated bead. Tries to
 * match the upstream `rig_handle` against a local rig name; falls back to
 * the only rig in the town when there is exactly one. Returns null when
 * neither rule matches — the caller can either skip the rig or fall back
 * to a different scoping rule.
 */
export function pickRigIdForWastelandBead(
  rigs: ReadonlyArray<{ id: string; name: string }>,
  rigHandle: string
): string | null {
  const handleMatch = rigs.find(r => r.name === rigHandle);
  if (handleMatch) return handleMatch.id;
  if (rigs.length === 1) return rigs[0].id;
  return null;
}
