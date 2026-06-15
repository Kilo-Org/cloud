import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  mergeSecurityAgentConfigPatch,
  parseSecurityAgentConfig,
} from './constants';

describe('security agent config', () => {
  it('defaults every model role to Kilo Balanced', () => {
    expect(DEFAULT_SECURITY_AGENT_TRIAGE_MODEL).toBe('kilo-auto/balanced');
    expect(DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL).toBe('kilo-auto/balanced');
    expect(DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL).toBe('kilo-auto/balanced');
    expect(parseSecurityAgentConfig({})).toMatchObject({
      model_slug: 'kilo-auto/balanced',
      triage_model_slug: 'kilo-auto/balanced',
      analysis_model_slug: 'kilo-auto/balanced',
      remediation_model_slug: 'kilo-auto/balanced',
    });
  });

  it('defaults New-finding Notifications off for legacy config', () => {
    expect(parseSecurityAgentConfig({}).new_finding_notifications_enabled).toBe(false);
  });

  it('defaults SLA tracking on for legacy config', () => {
    expect(parseSecurityAgentConfig({}).sla_enabled).toBe(true);
  });

  it('defaults SLA notifications off for legacy config', () => {
    expect(parseSecurityAgentConfig({}).sla_notifications_enabled).toBe(false);
  });

  it('tolerates malformed notification fields during general config reads', () => {
    expect(() =>
      parseSecurityAgentConfig({
        sla_notification_warning_days: 0,
        new_finding_notification_min_severity: 'all',
      })
    ).not.toThrow();
    expect(
      parseSecurityAgentConfig({
        sla_notification_warning_days: 0,
        new_finding_notification_min_severity: 'all',
      })
    ).toMatchObject({
      sla_notification_warning_days: 3,
      new_finding_notification_min_severity: 'high',
    });
  });

  it('preserves stored notification settings when patch values are omitted', () => {
    const merged = mergeSecurityAgentConfigPatch(
      {
        sla_notifications_enabled: false,
        sla_notification_min_severity: 'critical',
        sla_notification_warning_days: 7,
        new_finding_notifications_enabled: true,
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
      new_finding_notifications_enabled: true,
      new_finding_notification_min_severity: 'medium',
    });
  });
});
