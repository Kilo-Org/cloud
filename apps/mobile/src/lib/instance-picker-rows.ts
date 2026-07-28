import { type InstancePickerInstance } from '@/lib/picker-bridge';

export type LabeledInstance = InstancePickerInstance & {
  /**
   * Short, `connectionId`-derived suffix appended to the row's visible label
   * when its `(name, projectName)` pair is not unique in the list. The base
   * (name + project) label is always shown first; the suffix only appears for
   * duplicates. For unique rows this is `null` and the renderer omits it.
   */
  dedupSuffix: string | null;
};

/**
 * Pure: given a list of instances, return the same list with a `dedupSuffix`
 * on every row that shares its `(name, projectName)` pair with at least one
 * other row in the input. The suffix is a 6-character hex string derived
 * from a deterministic, non-cryptographic hash of the `connectionId` (see
 * `shortConnectionIdHash` below) — short, stable for the lifetime of the
 * connection, and visually distinguishable without being a long UUID.
 *
 * Order is preserved. Rows are not grouped or de-duplicated; the picker
 * renders one entry per live `connectionId` (an already-disconnected CLI
 * that briefly left a duplicate in the poll before the worker cleans it up
 * must remain visible, not silently collapsed).
 */
export function dedupeInstanceLabels(instances: InstancePickerInstance[]): LabeledInstance[] {
  if (instances.length === 0) {
    return [];
  }

  // Count occurrences of (name, projectName) so we only stamp a suffix on
  // rows that actually have a peer. O(n) with a Map keyed by the joined pair.
  const pairCounts = new Map<string, number>();
  for (const instance of instances) {
    const key = `${instance.name}\u0000${instance.projectName}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  return instances.map(instance => {
    const key = `${instance.name}\u0000${instance.projectName}`;
    const isDuplicate = (pairCounts.get(key) ?? 0) > 1;
    return {
      ...instance,
      dedupSuffix: isDuplicate ? shortConnectionIdHash(instance.connectionId) : null,
    };
  });
}

/**
 * Produce a 6-char hex suffix that:
 *   - is stable for a given `connectionId` (so the same row keeps the same
 *     suffix across polls)
 *   - is short enough to read at a glance
 *   - is derived purely from the connectionId (no UI-side state needed)
 *
 * `globalThis.crypto.subtle` is unavailable on Hermes, so we use a small
 * multiplicative string hash instead (the same pattern as the existing
 * deterministic-hue hash in `@/lib/agent-color.ts#agentColor` — no bitwise
 * operators, repo lint forbids them). The suffix is purely a visual
 * disambiguator, not a cryptographic identifier; this gives more than
 * enough collision resistance for the at-most-a-handful of CLI instances a
 * single user runs.
 */
function shortConnectionIdHash(connectionId: string): string {
  let hash = 0;
  for (let i = 0; i < connectionId.length; i += 1) {
    const codePoint = connectionId.codePointAt(i) ?? 0;
    hash = Math.trunc(hash * 31 + codePoint) % 2_147_483_647;
  }
  return Math.abs(hash).toString(16).padStart(6, '0').slice(0, 6);
}

/**
 * Pure classification of the instance picker's four feature states, per the
 * accepted plan's matrix. Kept separate from `InstancePickerScreen`'s JSX so
 * each state's trigger condition — and its distinctness from its
 * neighbors — is unit-testable without mounting the screen:
 *   - `loading`: the query has never produced data (not the same as a
 *     successful empty response).
 *   - `error`: the query itself failed (retryable — Retry CTA). Distinct
 *     from `empty`, which is a *successful* zero-instance response.
 *   - `ready`: a successful response, `instances` may be an empty array
 *     (the caller renders the Refresh-CTA empty card in that case) or
 *     populated (rows + Check for the selected one).
 */
type InstancePickerViewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; instances: InstancePickerInstance[] };

export function resolveInstancePickerViewState(input: {
  isLoading: boolean;
  isError: boolean;
  instances: InstancePickerInstance[];
}): InstancePickerViewState {
  if (input.isLoading) {
    return { kind: 'loading' };
  }
  if (input.isError) {
    return { kind: 'error' };
  }
  return { kind: 'ready', instances: input.instances };
}
