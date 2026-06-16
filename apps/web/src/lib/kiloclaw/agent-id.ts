// Client-side mirror of the controller's agent-id normalization
// (services/kiloclaw/controller/src/openclaw-agent-config.ts `normalizeAgentId`).
// The architecture wall prevents importing controller code into apps/web, so it
// is re-declared here.
//
// This is CORRECTNESS-BEARING, not just display: the create-timeout reconcile
// predicts the controller-assigned id from the typed name (there is no response
// to read when the request times out), then guards/checks against it. It must
// stay in lockstep with the controller copy — `agent-id.test.ts` pins the
// behavior; update both sides together if the controller's rule changes.

export function normalizeAgentId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'main';
  const lower = trimmed.toLowerCase();
  // Already a valid id (preserves underscores; does not collapse them to '-',
  // which is what keeps `foo_bar` and `foo-bar` distinct).
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return lower;
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || 'main'
  );
}

// Derive a stable, unix-safe workspace path from the agent name so users never
// have to type a machine path. Keyed on the normalized agent id for uniqueness.
export function workspaceFromName(name: string): string {
  return `/root/.openclaw/workspace-${normalizeAgentId(name)}`;
}
