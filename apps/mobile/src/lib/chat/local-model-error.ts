import { i18n } from '@/i18n';

export type LocalModelProblem = 'unavailable' | 'busy' | 'failed';

const LOCAL_ERROR_KEYS = {
  unavailable: 'modelChat.localModels.unavailable',
  busy: 'modelChat.localModels.busy',
  failed: 'modelChat.localModels.failed',
} as const satisfies Record<LocalModelProblem, string>;

/** An on-device model refused or failed a request. It is never a reason to route elsewhere. */
export class LocalModelError extends Error {
  readonly problem: LocalModelProblem;
  /** Fixed UI copy: native reasons are stable codes and are never shown. */
  readonly key: string;

  constructor(problem: LocalModelProblem) {
    super(i18n.t(LOCAL_ERROR_KEYS[problem]));
    this.problem = problem;
    this.key = LOCAL_ERROR_KEYS[problem];
  }
}
