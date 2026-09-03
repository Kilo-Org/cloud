import {
  baseGetSandboxStatusNextOutputSchema,
  baseGetSandboxStatusNextSchema,
  SANDBOX_STATUS_DETAIL_MESSAGES,
  type SandboxLifecycleStatus,
  type SandboxProviderLabel,
} from '@/routers/cloud-agent-next-schemas';
import type { FetchedSessionData, ResolvedSession } from '@kilocode/cloud-agent-sdk';

export const SANDBOX_STATUS_POLL_INTERVAL_MS = 5_000;
export const SANDBOX_STATUS_FRESHNESS_MS = 15_000;
export const SANDBOX_SLEEP_ESTIMATE_DELAY_MS = 120_000;
export const SANDBOX_SLEEP_SOON_MS = 60_000;

export function isSandboxStatusEligible({
  currentUserId,
  sessionId,
  sessionIdFromParams,
  organizationId,
  activeSessionType,
  isReadOnly,
  fetchedSessionData,
}: {
  currentUserId?: string;
  sessionId: string | null;
  sessionIdFromParams: string | null;
  organizationId?: string;
  activeSessionType: ResolvedSession['type'] | null;
  isReadOnly: boolean;
  fetchedSessionData: Pick<
    FetchedSessionData,
    'kiloSessionId' | 'cloudAgentSessionId' | 'organizationId'
  > | null;
}): boolean {
  return Boolean(
    currentUserId &&
    activeSessionType === 'cloud-agent' &&
    !isReadOnly &&
    fetchedSessionData &&
    fetchedSessionData.kiloSessionId === sessionIdFromParams &&
    fetchedSessionData.cloudAgentSessionId === sessionId &&
    (fetchedSessionData.organizationId ?? undefined) === organizationId &&
    baseGetSandboxStatusNextSchema.safeParse({ cloudAgentSessionId: sessionId }).success
  );
}

const statusLabels = {
  active: 'Active',
  sleeping: 'Sleeping',
  starting: 'Starting',
  stopping: 'Stopping',
  error: 'Error',
  unreachable: 'Unreachable',
  unknown: 'Unknown',
} satisfies Record<SandboxLifecycleStatus, string>;

const sandboxTypes = {
  shared: 'Shared',
  'isolated-small': 'Small',
  'isolated-standard': 'Standard',
  'code-review': 'Code review',
  devcontainer: 'Custom environment',
  unknown: 'Unknown',
};

export type SandboxStatusPresentation = {
  status: SandboxLifecycleStatus | 'sleeping-soon';
  label: string;
  detail: string;
  provider: SandboxProviderLabel;
  sandboxType: string;
  kiloCliVersion: string | null;
  wrapperVersion: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  estimatedSleepAt: number | null;
  sleepMinutesRemaining: number | null;
  nextChangeAt: number | null;
};

export function sandboxStatusPresentation({
  data,
  observation,
  dataUpdatedAt,
  freshAfter,
  estimateAfter,
  sessionActive,
  now,
}: {
  data: unknown;
  observation: 'checking' | 'paused' | 'unavailable' | 'observing';
  dataUpdatedAt: number;
  freshAfter: number;
  estimateAfter: number;
  sessionActive: boolean;
  now: number;
}): SandboxStatusPresentation {
  const unavailable: SandboxStatusPresentation = {
    status: 'unknown',
    label: 'Unknown',
    detail: SANDBOX_STATUS_DETAIL_MESSAGES.status_unavailable,
    provider: 'Unknown',
    sandboxType: 'Unknown',
    kiloCliVersion: null,
    wrapperVersion: null,
    startedAt: null,
    stoppedAt: null,
    estimatedSleepAt: null,
    sleepMinutesRemaining: null,
    nextChangeAt: null,
  };

  if (observation === 'checking') {
    return { ...unavailable, detail: 'Sandbox status is not available yet.' };
  }
  if (observation === 'paused') {
    return {
      ...unavailable,
      detail: 'Status updates are paused while this page is hidden or offline.',
    };
  }
  if (observation === 'unavailable') return unavailable;

  const parsed = baseGetSandboxStatusNextOutputSchema.safeParse(data);
  if (!parsed.success) return unavailable;
  const snapshot = parsed.data;
  const evidenceAt = Math.min(snapshot.observedAt, dataUpdatedAt);
  const freshUntil = evidenceAt + SANDBOX_STATUS_FRESHNESS_MS;
  if (evidenceAt < freshAfter || snapshot.observedAt > now || now >= freshUntil) {
    return { ...unavailable, detail: 'Sandbox status is out of date. Waiting for a fresh update.' };
  }

  const sleepDeadline =
    !sessionActive &&
    snapshot.status === 'active' &&
    snapshot.provider !== 'Unknown' &&
    snapshot.inactivityTimeoutMs !== null &&
    snapshot.observedAt >= estimateAfter &&
    snapshot.estimatedSleepAt !== null &&
    snapshot.estimatedSleepAt > now
      ? snapshot.estimatedSleepAt
      : null;
  const estimateVisibleAt =
    sleepDeadline !== null && snapshot.inactivityTimeoutMs !== null
      ? sleepDeadline - snapshot.inactivityTimeoutMs + SANDBOX_SLEEP_ESTIMATE_DELAY_MS
      : null;
  const estimatedSleepAt =
    estimateVisibleAt !== null && now >= estimateVisibleAt ? sleepDeadline : null;
  const sleepMinutesRemaining =
    estimatedSleepAt !== null ? Math.ceil((estimatedSleepAt - now) / 60_000) : null;
  const sleepingSoon = sleepDeadline !== null && sleepDeadline - now <= SANDBOX_SLEEP_SOON_MS;
  const deadlines = [freshUntil];
  if (sleepDeadline !== null) {
    deadlines.push(sleepDeadline);
    const sleepingSoonAt = sleepDeadline - SANDBOX_SLEEP_SOON_MS;
    if (sleepingSoonAt > now) deadlines.push(sleepingSoonAt);
  }
  if (estimateVisibleAt !== null && estimateVisibleAt > now) deadlines.push(estimateVisibleAt);
  if (estimatedSleepAt !== null && sleepMinutesRemaining !== null) {
    deadlines.push(estimatedSleepAt - (sleepMinutesRemaining - 1) * 60_000);
  }

  const runtime = snapshot.runtime;

  return {
    status: sleepingSoon ? 'sleeping-soon' : snapshot.status,
    label: sleepingSoon ? 'Sleeping soon' : statusLabels[snapshot.status],
    detail: sleepingSoon
      ? 'The sandbox will sleep soon if inactivity continues.'
      : snapshot.status === 'sleeping'
        ? 'Send a message to resume.'
        : SANDBOX_STATUS_DETAIL_MESSAGES[snapshot.detailCode],
    provider: snapshot.provider,
    sandboxType: sandboxTypes[runtime?.sandboxType ?? 'unknown'],
    kiloCliVersion: runtime?.kiloCliVersion ?? null,
    wrapperVersion: runtime?.wrapperVersion ?? null,
    startedAt: runtime?.startedAt ?? null,
    stoppedAt: runtime?.stoppedAt ?? null,
    estimatedSleepAt,
    sleepMinutesRemaining,
    nextChangeAt: Math.min(...deadlines),
  };
}
