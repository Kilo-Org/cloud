import { mergeSecurityAgentConfigPatch } from './constants';

describe('mergeSecurityAgentConfigPatch', () => {
  it('preserves stored notification settings when patch values are omitted', () => {
    const merged = mergeSecurityAgentConfigPatch(
      {
        sla_notifications_enabled: false,
        sla_notification_min_severity: 'critical',
        sla_notification_warning_days: 7,
        new_finding_notification_min_severity: 'medium',
      },
      {
        sla_notification_warning_days: undefined,
        auto_analysis_enabled: true,
      }
    );

    expect(merged).toMatchObject({
      auto_analysis_enabled: true,
      sla_notifications_enabled: false,
      sla_notification_min_severity: 'critical',
      sla_notification_warning_days: 7,
      new_finding_notification_min_severity: 'medium',
    });
  });
});
