// The sandbox's lifecycle in the app's language. The worker's snapshot carries
// a closed status and detail code; every one of them resolves through the
// catalog, so the session sheet never prints a worker sentence or a raw code.
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { type TFunction } from 'i18next';

export type SandboxStatusRow =
  inferRouterOutputs<MobileRouter>['cloudAgentNext']['getSandboxStatus'];

const STATUS_LABEL_KEYS = {
  active: 'agentChat.environment.sandboxActive',
  sleeping: 'agentChat.environment.sandboxSleeping',
  starting: 'agentChat.environment.sandboxStarting',
  stopping: 'agentChat.environment.sandboxStopping',
  error: 'agentChat.environment.sandboxError',
  unreachable: 'agentChat.environment.sandboxUnreachable',
  unknown: 'agentChat.environment.sandboxStatusUnknown',
} satisfies Record<SandboxStatusRow['status'], string>;

/** The one line naming the sandbox's state. */
export function sandboxStatusLabel(status: SandboxStatusRow['status'], t: TFunction): string {
  return t(STATUS_LABEL_KEYS[status]);
}

/**
 * What the state means for the person and what they can do about it. A state
 * whose label already says everything carries no detail line.
 */
const DETAIL_KEYS = {
  sandbox_ready: null,
  sandbox_stopped: 'agentChat.environment.sandboxDetailStopped',
  sandbox_starting: null,
  sandbox_stopping: null,
  sandbox_failed: 'agentChat.environment.sandboxDetailFailed',
  connection_unavailable: 'agentChat.environment.sandboxDetailConnection',
  status_unavailable: 'agentChat.environment.sandboxDetailUnavailable',
  insufficient_evidence: 'agentChat.environment.sandboxDetailInsufficient',
  check_needed: 'agentChat.environment.sandboxDetailCheckNeeded',
} satisfies Record<SandboxStatusRow['detailCode'], string | null>;

export function sandboxDetailText(
  detailCode: SandboxStatusRow['detailCode'],
  t: TFunction
): string | null {
  const key = DETAIL_KEYS[detailCode];
  return key === null ? null : t(key);
}
