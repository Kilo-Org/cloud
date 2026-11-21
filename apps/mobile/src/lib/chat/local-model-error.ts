import { i18n } from '@/i18n';

export type LocalModelProblem =
  | 'unavailable'
  | 'busy'
  | 'failed'
  | 'background'
  | 'downloadRequired'
  | 'downloading'
  | 'preparing'
  | 'updateRequired'
  | 'settingsOff'
  | 'ineligible'
  | 'quotaExhausted'
  | 'checkFailed';

const LOCAL_ERROR_KEYS = {
  unavailable: 'modelChat.localModels.unavailable',
  busy: 'modelChat.localModels.busy',
  failed: 'modelChat.localModels.failed',
  background: 'modelChat.localModels.background',
  downloadRequired: 'modelChat.localModels.reasons.downloadable',
  downloading: 'modelChat.localModels.reasons.downloading',
  preparing: 'modelChat.localModels.reasons.modelNotReady',
  updateRequired: 'modelChat.localModels.reasons.aicoreUpdateRequired',
  settingsOff: 'modelChat.localModels.reasons.appleIntelligenceDisabled',
  ineligible: 'modelChat.localModels.reasons.deviceNotEligible',
  quotaExhausted: 'modelChat.localModels.reasons.batteryQuota',
  checkFailed: 'modelChat.localModels.reasons.checkFailed',
} as const satisfies Record<LocalModelProblem, string>;

/** An on-device model refused or failed a request. It is never a reason to route elsewhere. */
export class LocalModelError extends Error {
  readonly problem: LocalModelProblem;
  /**
   * Fixed UI copy: a native reason is a stable code that resolves to one
   * problem class, and the class's key — never the code — picks the copy.
   */
  readonly key: string;

  constructor(problem: LocalModelProblem) {
    super(i18n.t(LOCAL_ERROR_KEYS[problem]));
    this.problem = problem;
    this.key = LOCAL_ERROR_KEYS[problem];
  }
}
