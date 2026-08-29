import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { parseTimestamp } from '@/lib/utils';

export type LabeledInstance = InstancePickerInstance & {
  /** Exact branch/start text rendered without further truncation by the picker. */
  displayFacts: string;
  /** Stable connection hash, only when the displayed identity still has a peer. */
  dedupSuffix: string | null;
};

/** Preserve every connection and its order; disambiguate displayed identities, not raw metadata. */
export function dedupeInstanceLabels(
  instances: InstancePickerInstance[],
  locale = i18n.language
): LabeledInstance[] {
  const labels = new Map<string, LabeledInstance>();
  return instances.map(instance => {
    // eslint-disable-next-line typescript-eslint/no-misused-spread -- Preserve the existing code-point shortening boundary without splitting surrogate pairs.
    const branch = [...(instance.gitBranch ?? '')];
    const displayBranch = branch.length > 20 ? `${branch.slice(0, 20).join('')}…` : branch.join('');
    const started =
      instance.startedAt === null
        ? ''
        : `${i18n.t('codeReviewer.reviewDetail.started', { lng: locale })} ${formatDate(
            parseTimestamp(instance.startedAt),
            locale,
            { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
          )}`;
    const displayFacts = [displayBranch, started].filter(Boolean).join(' · ');
    // Kind already has its own group. Compare only the facts the user can see,
    // including shortened branches and start times displayed to the minute.
    const labelKey = JSON.stringify([
      instance.kind,
      instance.name,
      instance.projectName,
      displayFacts,
    ]);
    const row: LabeledInstance = { ...instance, displayFacts, dedupSuffix: null };
    const peer = labels.get(labelKey);
    if (peer) {
      peer.dedupSuffix = shortConnectionIdHash(peer.connectionId);
      row.dedupSuffix = shortConnectionIdHash(row.connectionId);
    } else {
      labels.set(labelKey, row);
    }
    return row;
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
