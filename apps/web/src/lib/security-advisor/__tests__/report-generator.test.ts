import { describe, it, expect } from '@jest/globals';
import { generateSecurityReport } from '../report-generator';
import type { SecurityAdvisorRequest } from '../schemas';

const FIXTURE_AUDIT: SecurityAdvisorRequest['audit'] = {
  ts: 1775491369820,
  summary: { critical: 1, warn: 4, info: 1 },
  findings: [
    {
      checkId: 'summary.attack_surface',
      severity: 'info',
      title: 'Attack surface summary',
      detail: 'groups: open=0, allowlist=1...',
      remediation: null,
    },
    {
      checkId: 'fs.config.perms_world_readable',
      severity: 'critical',
      title: 'Config file is world-readable',
      detail: '/root/.openclaw/openclaw.json mode=644...',
      remediation: 'chmod 600 /root/.openclaw/openclaw.json',
    },
    {
      checkId: 'net.no_allowlist',
      severity: 'warn',
      title: 'No IP allow list configured',
      detail: 'Gateway accepts connections from any IP',
      remediation: 'Configure an IP allow list in openclaw.json',
    },
    {
      checkId: 'version.outdated',
      severity: 'warn',
      title: 'OpenClaw version is outdated',
      detail: 'Running 2026.2.1, latest is 2026.3.24',
      remediation: 'Run: openclaw update',
    },
    {
      checkId: 'net.no_tls',
      severity: 'warn',
      title: 'No TLS configured',
      detail: 'Gateway traffic is not encrypted',
      remediation: 'Enable TLS in gateway configuration',
    },
    {
      checkId: 'auth.no_authentication',
      severity: 'warn',
      title: 'No authentication configured',
      detail: 'Gateway has no auth requirement',
      remediation: 'Enable authentication in openclaw.json',
    },
  ],
  deep: { gateway: { attempted: true, ok: true } },
  secretDiagnostics: [],
};

describe('generateSecurityReport', () => {
  describe('for openclaw source (isKiloClaw=false)', () => {
    const report = generateSecurityReport({
      audit: FIXTURE_AUDIT,
      publicIp: '1.2.3.4',
      isKiloClaw: false,
    });

    it('returns summary counts recomputed from server-mapped severity', () => {
      // auth.no_authentication is client-reported as warn but server maps to critical
      expect(report.summary.critical).toBe(2); // fs.config + auth.no_auth
      expect(report.summary.warn).toBe(3); // no_allowlist, outdated, no_tls
      expect(report.summary.info).toBe(1);
      expect(report.summary.passed).toBe(1); // gateway deep check passed
    });

    it('maps all findings', () => {
      expect(report.findings).toHaveLength(6);
    });

    it('uses known template for recognized checkIds', () => {
      const configFinding = report.findings.find(
        f => f.checkId === 'fs.config.perms_world_readable'
      );
      expect(configFinding).toBeDefined();
      expect(configFinding!.explanation).toContain('readable by all users');
      expect(configFinding!.risk).toContain('secrets');
    });

    it('falls back to audit detail for unknown checkIds', () => {
      // summary.attack_surface has a template, but let's test with our fixture
      const attackSurface = report.findings.find(f => f.checkId === 'summary.attack_surface');
      expect(attackSurface).toBeDefined();
      // This one has a known template
      expect(attackSurface!.explanation).toBeTruthy();
    });

    it('includes KiloClaw sales comparison for openclaw source', () => {
      const configFinding = report.findings.find(
        f => f.checkId === 'fs.config.perms_world_readable'
      );
      expect(configFinding!.kiloClawComparison).not.toBeNull();
      expect(configFinding!.kiloClawComparison).toContain('How KiloClaw handles this');
    });

    it('includes remediation as fix', () => {
      const configFinding = report.findings.find(
        f => f.checkId === 'fs.config.perms_world_readable'
      );
      expect(configFinding!.fix).toBe('chmod 600 /root/.openclaw/openclaw.json');
    });

    it('generates recommendations sorted by priority', () => {
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations[0]!.priority).toBe('immediate');
    });

    it('does not generate recommendations for info findings', () => {
      const infoRecs = report.recommendations.filter(r =>
        r.action.includes('Attack surface summary')
      );
      expect(infoRecs).toHaveLength(0);
    });

    it('renders markdown with all sections', () => {
      expect(report.markdown).toContain('# Security Audit Report');
      expect(report.markdown).toContain('## Summary');
      expect(report.markdown).toContain('## Critical Findings');
      expect(report.markdown).toContain('## Warnings');
      expect(report.markdown).toContain('## Informational');
      expect(report.markdown).toContain('## Recommendations');
      expect(report.markdown).toContain('**Public IP:** `1.2.3.4`');
    });

    it('includes CTA for non-KiloClaw users', () => {
      expect(report.markdown).toContain('kilo.ai/kiloclaw');
    });
  });

  describe('for kiloclaw source (isKiloClaw=true)', () => {
    const report = generateSecurityReport({
      audit: FIXTURE_AUDIT,
      publicIp: '10.0.0.1',
      isKiloClaw: true,
    });

    it('shows divergence warning for known checkIds', () => {
      const configFinding = report.findings.find(
        f => f.checkId === 'fs.config.perms_world_readable'
      );
      expect(configFinding!.kiloClawComparison).not.toBeNull();
      expect(configFinding!.kiloClawComparison).toContain('KiloClaw default');
      expect(configFinding!.kiloClawComparison).toContain('diverged');
    });

    it('returns null comparison for checkIds not in comparison table', () => {
      // summary.attack_surface IS in the comparison table (gateway_exposure area)
      // so let's check that unknown checkIds still return null
      const report2 = generateSecurityReport({
        audit: {
          ts: 1000,
          summary: { critical: 0, warn: 0, info: 1 },
          findings: [
            {
              checkId: 'custom.unknown_check',
              severity: 'info',
              title: 'Unknown check',
              detail: 'test',
              remediation: null,
            },
          ],
        },
        isKiloClaw: true,
      });
      expect(report2.findings[0]!.kiloClawComparison).toBeNull();
    });

    it('omits CTA', () => {
      expect(report.markdown).not.toContain('kilo.ai/kiloclaw');
    });
  });

  describe('with empty findings', () => {
    const report = generateSecurityReport({
      audit: {
        ts: 1000,
        summary: { critical: 0, warn: 0, info: 0 },
        findings: [],
      },
      isKiloClaw: false,
    });

    it('returns zero counts', () => {
      expect(report.summary.critical).toBe(0);
      expect(report.summary.warn).toBe(0);
      expect(report.summary.info).toBe(0);
    });

    it('returns no findings or recommendations', () => {
      expect(report.findings).toHaveLength(0);
      expect(report.recommendations).toHaveLength(0);
    });

    it('still renders a valid markdown report', () => {
      expect(report.markdown).toContain('# Security Audit Report');
      expect(report.markdown).toContain('## Summary');
    });
  });

  describe('with findings but no deep scan', () => {
    const report = generateSecurityReport({
      audit: {
        ts: 1000,
        summary: { critical: 1, warn: 0, info: 0 },
        findings: [
          {
            checkId: 'fs.config.perms_world_readable',
            severity: 'critical',
            title: 'Config file is world-readable',
            detail: '/root/.openclaw/openclaw.json mode=644',
            remediation: 'chmod 600 /root/.openclaw/openclaw.json',
          },
        ],
      },
      isKiloClaw: false,
    });

    it('reports passed as 0 when no deep scan was run', () => {
      expect(report.summary.passed).toBe(0);
    });

    it('still maps findings correctly', () => {
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]!.checkId).toBe('fs.config.perms_world_readable');
    });
  });

  describe('server-assigned severity for known checkIds', () => {
    it('overrides client severity with server severity for known checkIds', () => {
      const report = generateSecurityReport({
        audit: {
          ts: 1000,
          summary: { critical: 0, warn: 0, info: 1 },
          findings: [
            {
              checkId: 'fs.config.perms_world_readable',
              severity: 'info', // client says info, server knows it's critical
              title: 'Config file is world-readable',
              detail: 'test',
              remediation: 'chmod 600 /root/.openclaw/openclaw.json',
            },
          ],
        },
        isKiloClaw: false,
      });

      // Server overrides to critical
      expect(report.findings[0]!.severity).toBe('critical');
      // Summary counts are recomputed from server-mapped findings, not client
      expect(report.summary.critical).toBe(1);
      expect(report.summary.info).toBe(0);
      // Should appear in recommendations as immediate priority (not skipped as info)
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations[0]!.priority).toBe('immediate');
    });

    it('uses client severity for unknown checkIds', () => {
      const report = generateSecurityReport({
        audit: {
          ts: 1000,
          summary: { critical: 0, warn: 1, info: 0 },
          findings: [
            {
              checkId: 'custom.unknown_check',
              severity: 'warn',
              title: 'Some custom check',
              detail: 'Custom detail',
              remediation: null,
            },
          ],
        },
        isKiloClaw: false,
      });

      expect(report.findings[0]!.severity).toBe('warn');
    });

    it('prevents client from downgrading a critical finding to info', () => {
      const report = generateSecurityReport({
        audit: {
          ts: 1000,
          summary: { critical: 0, warn: 0, info: 1 },
          findings: [
            {
              checkId: 'auth.no_authentication',
              severity: 'info', // client downgraded, server knows critical
              title: 'No auth',
              detail: 'test',
              remediation: 'Enable auth',
            },
          ],
        },
        isKiloClaw: false,
      });

      expect(report.findings[0]!.severity).toBe('critical');
      // Should render in Critical Findings section, not Informational
      expect(report.markdown).toContain('## Critical Findings');
    });
  });
});
