import { describe, expect, it } from '@jest/globals';
import {
  buildSecurityConfigFormState,
  buildSecurityConfigSavePayload,
  type SecurityConfigFormState,
} from './security-config-types';

const baseFormState: SecurityConfigFormState = {
  slaConfig: { critical: 15, high: 30, medium: 45, low: 90 },
  slaEnabled: true,
  repositorySelectionMode: 'selected',
  selectedRepositoryIds: [],
  triageModelSlug: 'triage-model',
  analysisModelSlug: 'analysis-model',
  analysisMode: 'auto',
  autoDismissEnabled: false,
  autoDismissConfidenceThreshold: 'high',
  autoAnalysisEnabled: false,
  autoAnalysisMinSeverity: 'high',
  autoAnalysisIncludeExisting: false,
  autoRemediationEnabled: true,
  autoRemediationMinSeverity: 'high',
  autoRemediationIncludeExisting: false,
  autoRemediationRequireApproval: false,
  remediationModelSlug: 'remediation-model',
  slaNotificationsEnabled: false,
  slaNotificationMinSeverity: 'high',
  slaNotificationWarningDays: 3,
  newFindingNotificationsEnabled: false,
  newFindingNotificationMinSeverity: 'high',
};

describe('SecurityConfigForm config round-trip', () => {
  it('includes autoRemediationRequireApproval in the save payload', () => {
    const payload = buildSecurityConfigSavePayload(baseFormState);

    expect(payload.autoRemediationRequireApproval).toBe(false);
  });

  it('preserves a hydrated autoRemediationRequireApproval=false value', () => {
    const formState = buildSecurityConfigFormState({ autoRemediationRequireApproval: false });

    expect(formState.autoRemediationRequireApproval).toBe(false);
    expect(buildSecurityConfigSavePayload(formState).autoRemediationRequireApproval).toBe(false);
  });

  it('defaults autoRemediationRequireApproval to true when the config omits it', () => {
    const formState = buildSecurityConfigFormState(undefined);

    expect(formState.autoRemediationRequireApproval).toBe(true);
  });
});
