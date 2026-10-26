import { egressPolicySchema, type EgressMode } from '@kilocode/worker-utils/egress-allowlist';

/** Preserve separate shell scopes when opening a legacy multi-script environment. */
export function toEnvironmentScript(commands: readonly string[]): string {
  if (commands.length <= 1) return commands[0] ?? '';
  return commands
    .map(command => `bash -e -o pipefail -c '${command.replace(/'/g, "'\\''")}'`)
    .join('\n\n');
}

export function toEnvironmentCommands(script: string): string[] {
  const trimmed = script.trim();
  return trimmed ? [trimmed] : [];
}

<<<<<<< 0193c81970e48a3312b6f0f5f2b2e6014ad23a1a
/** Builds use saved configuration. Keep the editor baseline stable during status polling. */
export function hasEnvironmentFormChanges(
  saved: { script: string; variablesText: string; sandboxAllocation: string | null },
  draft: { script: string; variablesText: string; sandboxAllocation: string | null }
): boolean {
  return (
    saved.script !== draft.script ||
    saved.variablesText !== draft.variablesText ||
    saved.sandboxAllocation !== draft.sandboxAllocation
  );
||||||| b63e3f2b12ee2b8876dc266edd1e260553936f92
=======
/** UI choices. The API stores an unrestricted or allowlist mode. */
export type NetworkAccessMode = 'none' | 'limited' | 'full';

export type NetworkAccessDraft = {
  mode: NetworkAccessMode;
  /** One hostname per line. Kept while None or Full hides the editor. */
  domains: string;
};

export type EgressPolicyPayload = {
  egressMode?: EgressMode;
  egressAllowlist?: string[];
};

export type EgressPolicyResult = {
  /** Absent when the draft matches the stored policy, so saving leaves it untouched. */
  policy?: EgressPolicyPayload;
  error: string | null;
};

/**
 * Maps a stored policy to the compact choices. A legacy absent policy is Full,
 * and an allowlist without additional domains is None.
 */
export function toNetworkAccessDraft(
  egressMode: EgressMode | null,
  egressAllowlist: string[] | null
): NetworkAccessDraft {
  if (egressMode !== 'allowlist') return { mode: 'full', domains: '' };
  const domains = egressAllowlist ?? [];
  return { mode: domains.length > 0 ? 'limited' : 'none', domains: domains.join('\n') };
}

function parseNetworkDomains(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function toEgressPolicy(draft: NetworkAccessDraft): EgressPolicyResult {
  const domains = parseNetworkDomains(draft.domains);
  if (draft.mode === 'limited' && domains.length === 0) {
    return { error: 'Add at least one domain for Limited access.' };
  }
  const parsed = egressPolicySchema.safeParse(
    draft.mode === 'full'
      ? { egressMode: 'unrestricted' }
      : {
          egressMode: 'allowlist',
          egressAllowlist: draft.mode === 'none' ? [] : domains,
        }
  );
  if (!parsed.success) {
    const tooMany = parsed.error.issues.some(issue => issue.code === 'too_big');
    return {
      error: tooMany
        ? 'Check the domains. Add no more than 100 domains.'
        : 'Check the domains. Use an exact ASCII hostname without a scheme, path, wildcard, or IP address.',
    };
  }
  return { policy: parsed.data, error: null };
}

/**
 * Converts the draft to the API policy. None ignores hidden text and saves an
 * empty allowlist; Full omits the list. The shared schema applies normalization
 * and its submitted-list limit before removing duplicates.
 */
export function buildEgressPolicy(
  draft: NetworkAccessDraft,
  baseline: NetworkAccessDraft
): EgressPolicyResult {
  const next = toEgressPolicy(draft);
  if (next.error) return next;
  const initial = toEgressPolicy(baseline);
  if (!initial.error && JSON.stringify(next.policy) === JSON.stringify(initial.policy)) {
    return { error: null };
  }
  return next;
>>>>>>> 0fd5178900beee5cf9f6ade89d4b56c5b16eedf9
}
