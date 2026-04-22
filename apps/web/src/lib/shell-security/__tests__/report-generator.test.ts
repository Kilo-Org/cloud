import { describe, it, expect } from '@jest/globals';
import { generateSecurityReport } from '../report-generator';
import type { AuditFinding, ShellSecurityRequest } from '../schemas';
import type { LoadedShellSecurityContent } from '../content-loader';
import { KILOCLAW_MITIGATED_CHECKS } from '../kiloclaw-mitigations';

/**
 * Build a test fixture that mirrors the seeded DB content.
 *
 * Tests used to rely on module-level hardcoded maps in report-generator.ts.
 * Now that content comes from the DB via content-loader, each test constructs
 * an equivalent in-memory content object. This keeps tests hermetic while
 * still exercising the server-authoritative severity override + comparison
 * framing behavior.
 */
function buildTestContent(): LoadedShellSecurityContent {
  const checkCatalog = new Map<
    string,
    { severity: 'critical' | 'warn' | 'info'; explanation: string; risk: string }
  >();
  checkCatalog.set('fs.config.perms_world_readable', {
    severity: 'critical',
    explanation: 'The OpenClaw configuration file is readable by all users on the system.',
    risk: 'Any process can read your secrets.',
  });
  checkCatalog.set('auth.no_authentication', {
    severity: 'critical',
    explanation: 'The OpenClaw instance has no authentication configured.',
    risk: 'Unauthorized users can execute commands.',
  });
  checkCatalog.set('net.no_allowlist', {
    severity: 'warn',
    explanation: 'No IP allow list is configured.',
    risk: 'Authentication is the only barrier.',
  });
  checkCatalog.set('net.no_tls', {
    severity: 'warn',
    explanation: 'Traffic to the gateway is not encrypted.',
    risk: 'Plaintext traffic can be intercepted.',
  });
  checkCatalog.set('version.outdated', {
    severity: 'warn',
    explanation: 'OpenClaw version is outdated.',
    risk: 'Older versions may contain known vulnerabilities.',
  });
  checkCatalog.set('summary.attack_surface', {
    severity: 'info',
    explanation: 'Summary of the attack surface.',
    risk: 'More entry points mean more risk.',
  });

  const kiloclawCoverage = [
    {
      area: 'config_permissions',
      summary: 'Config files restricted to owner only',
      detail: 'KiloClaw provisions strict file permissions.',
      matchCheckIds: ['fs.config.perms_world_readable'],
    },
    {
      area: 'gateway_exposure',
      summary: 'Gateway bound to localhost only',
      detail: 'Reverse proxy handles external access.',
      matchCheckIds: ['net.no_tls', 'summary.attack_surface'],
    },
    {
      area: 'network_allowlist',
      summary: 'Strict IP allow listing',
      detail: 'Default deny firewall.',
      matchCheckIds: ['net.no_allowlist'],
    },
  ];

  // Only the six Tier 1 editable keys. Section headings, summary-line
  // formats, and per-finding labels are inline in report-generator.ts and
  // are not looked up from content.
  const content = new Map<string, string>([
    ['section.next_step', '## Next step: try KiloClaw free'],
    ['cta.body', '**Start a free trial at [kilo.ai/kiloclaw](https://kilo.ai/kiloclaw).**'],
    ['framing.openclaw', '**How KiloClaw handles this:** {summary}. {detail}'],
    [
      'framing.kiloclaw',
      '**KiloClaw default:** {summary}. Your instance has diverged from this default configuration.',
    ],
    ['fallback.risk', 'Review this finding: {detail}'],
    ['fallback.recommendation_action', 'Address finding: {title} ({checkId})'],
  ]);

  return { checkCatalog, kiloclawCoverage, content };
}

const FIXTURE_AUDIT: ShellSecurityRequest['audit'] = {
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
    const content = buildTestContent();
    const report = generateSecurityReport({
      audit: FIXTURE_AUDIT,
      publicIp: '1.2.3.4',
      isKiloClaw: false,
      content,
    });

    it('returns summary counts recomputed from server-mapped severity', () => {
      expect(report.summary.critical).toBe(2);
      expect(report.summary.warn).toBe(3);
      expect(report.summary.info).toBe(1);
      expect(report.summary.passed).toBe(1);
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
      const attackSurface = report.findings.find(f => f.checkId === 'summary.attack_surface');
      expect(attackSurface).toBeDefined();
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
      expect(report.markdown).toContain('## Security Grade:');
      expect(report.markdown).toContain('## Summary');
      expect(report.markdown).toContain('## Critical Findings');
      expect(report.markdown).toContain('## Warnings');
      expect(report.markdown).toContain('## Informational');
      expect(report.markdown).toContain('## Recommendations');
      expect(report.markdown).toContain('**Public IP:** `1.2.3.4`');
    });

    it('computes a grade + score based on findings', () => {
      // Fixture: 2 critical (after server override) + 3 warn → 100 - 70 - 12 = 18 → F
      expect(report.score).toBe(18);
      expect(report.grade).toBe('F');
      expect(report.markdown).toContain('## Security Grade: F');
      expect(report.markdown).toContain('**Score:** 18 / 100');
    });

    it('uses severity-matching labels on recommendation badges', () => {
      // Previously the badges said [IMMEDIATE] / [HIGH] which didn't match the
      // "critical" / "warning" vocabulary in the rest of the report. Rendered
      // labels now mirror severity so there's one vocabulary throughout.
      expect(report.markdown).toContain('[CRITICAL]');
      expect(report.markdown).toContain('[WARNING]');
      expect(report.markdown).not.toContain('[IMMEDIATE]');
      expect(report.markdown).not.toContain('[HIGH]');
    });

    it('includes CTA for non-KiloClaw users', () => {
      expect(report.markdown).toContain('kilo.ai/kiloclaw');
      expect(report.markdown).toContain('## Next step: try KiloClaw free');
    });

    it('does not leak agent-directive HTML comments to end users', () => {
      expect(report.markdown).not.toContain('<!--');
      expect(report.markdown).not.toContain('display-verbatim');
    });
  });

  describe('for kiloclaw source (isKiloClaw=true)', () => {
    const content = buildTestContent();
    const report = generateSecurityReport({
      audit: FIXTURE_AUDIT,
      publicIp: '10.0.0.1',
      isKiloClaw: true,
      content,
    });

    it('shows divergence warning for known checkIds', () => {
      // Use net.no_tls rather than fs.config.perms_world_readable — the
      // latter is in KILOCLAW_MITIGATED_CHECKS and gets filtered out of
      // rendered findings on KiloClaw. net.no_tls is not mitigated,
      // survives the filter, and matches the gateway_exposure coverage
      // area in buildTestContent() so the divergence framing should
      // attach to it.
      const tlsFinding = report.findings.find(f => f.checkId === 'net.no_tls');
      expect(tlsFinding!.kiloClawComparison).not.toBeNull();
      expect(tlsFinding!.kiloClawComparison).toContain('KiloClaw default');
      expect(tlsFinding!.kiloClawComparison).toContain('diverged');
    });

    it('returns null comparison for checkIds not in comparison table', () => {
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
        content,
      });
      expect(report2.findings[0]!.kiloClawComparison).toBeNull();
    });

    it('omits CTA', () => {
      expect(report.markdown).not.toContain('kilo.ai/kiloclaw');
      expect(report.markdown).not.toContain('## Next step: try KiloClaw free');
    });
  });

  describe('with empty findings', () => {
    const content = buildTestContent();
    const report = generateSecurityReport({
      audit: {
        ts: 1000,
        summary: { critical: 0, warn: 0, info: 0 },
        findings: [],
      },
      isKiloClaw: false,
      content,
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
    const content = buildTestContent();
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
      content,
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
              severity: 'info',
              title: 'Config file is world-readable',
              detail: 'test',
              remediation: 'chmod 600 /root/.openclaw/openclaw.json',
            },
          ],
        },
        isKiloClaw: false,
        content: buildTestContent(),
      });

      expect(report.findings[0]!.severity).toBe('critical');
      expect(report.summary.critical).toBe(1);
      expect(report.summary.info).toBe(0);
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
        content: buildTestContent(),
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
              severity: 'info',
              title: 'No auth',
              detail: 'test',
              remediation: 'Enable auth',
            },
          ],
        },
        isKiloClaw: false,
        content: buildTestContent(),
      });

      expect(report.findings[0]!.severity).toBe('critical');
      expect(report.markdown).toContain('## Critical Findings');
    });
  });

  describe('unknown checkId fallback', () => {
    it('uses fallback.risk template when no checkTemplate matches', () => {
      const report = generateSecurityReport({
        audit: {
          ts: 1000,
          summary: { critical: 0, warn: 1, info: 0 },
          findings: [
            {
              checkId: 'custom.brand_new_check',
              severity: 'warn',
              title: 'New check',
              detail: 'Something was reported',
              remediation: null,
            },
          ],
        },
        isKiloClaw: false,
        content: buildTestContent(),
      });

      expect(report.findings[0]!.risk).toBe('Review this finding: Something was reported');
    });
  });

  describe('KiloClaw-mitigated finding suppression', () => {
    // The list lives in kiloclaw-mitigations.ts. These tests guard filtering
    // BEHAVIOR (dropped from rendered findings, not counted in grade,
    // disclosure note rendered) — test inputs are derived from the live
    // KILOCLAW_MITIGATED_CHECKS map so adding or removing entries doesn't
    // silently break assertions here.
    const MITIGATED_IDS = Array.from(KILOCLAW_MITIGATED_CHECKS.keys());
    const MITIGATED_EXAMPLE = MITIGATED_IDS[0]!;
    const NOT_MITIGATED_EXAMPLE = 'tools.exec.security_full_configured';

    function auditWith(checkIds: string[]): ShellSecurityRequest['audit'] {
      return {
        ts: 1,
        summary: { critical: 0, warn: checkIds.length, info: 0 },
        findings: checkIds.map((id, i) => ({
          checkId: id,
          severity: 'warn' as const,
          title: `t${i}`,
          detail: `d${i}`,
          remediation: null,
        })),
      };
    }

    it('drops mitigated findings on KiloClaw and excludes them from the grade', () => {
      const content = buildTestContent();
      const report = generateSecurityReport({
        audit: auditWith([MITIGATED_EXAMPLE, NOT_MITIGATED_EXAMPLE]),
        isKiloClaw: true,
        content,
      });

      // Only the non-mitigated finding survives into the rendered findings.
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]!.checkId).toBe(NOT_MITIGATED_EXAMPLE);

      // Grade is computed on the filtered count (1 warn, not 2).
      expect(report.score).toBe(96);
      expect(report.grade).toBe('A');
    });

    it('keeps the same finding visible on self-hosted OpenClaw', () => {
      const content = buildTestContent();
      const report = generateSecurityReport({
        audit: auditWith([MITIGATED_EXAMPLE, NOT_MITIGATED_EXAMPLE]),
        isKiloClaw: false,
        content,
      });

      // Nothing is suppressed for OpenClaw — both findings are real issues there.
      expect(report.findings).toHaveLength(2);
      expect(report.markdown).not.toContain('hidden');
      expect(report.score).toBe(92);
    });

    it('renders a disclosure note when any findings are suppressed', () => {
      const content = buildTestContent();
      const report = generateSecurityReport({
        audit: auditWith([MITIGATED_EXAMPLE, NOT_MITIGATED_EXAMPLE]),
        isKiloClaw: true,
        content,
      });

      // Plural-aware message, references external mitigation, not silent.
      expect(report.markdown).toContain('1 additional finding hidden');
      expect(report.markdown).toContain("KiloClaw's managed infrastructure");
      expect(report.markdown).toContain('Not counted toward the grade');
    });

    it('pluralizes the disclosure note correctly for multiple suppressions', () => {
      // Guard: this test specifically exercises the plural branch, so it
      // requires >=2 entries in the live list. If the list ever shrinks to
      // 1, fail loudly here with a clear pointer rather than silently
      // asserting against the wrong message.
      expect(MITIGATED_IDS.length).toBeGreaterThanOrEqual(2);

      const content = buildTestContent();
      const report = generateSecurityReport({
        audit: auditWith(MITIGATED_IDS),
        isKiloClaw: true,
        content,
      });

      expect(report.markdown).toContain(`${MITIGATED_IDS.length} additional findings hidden`);
      expect(report.findings).toHaveLength(0);
      expect(report.grade).toBe('A'); // All findings suppressed → clean 100.
    });

    it('omits the disclosure note entirely when nothing was suppressed', () => {
      const content = buildTestContent();
      const report = generateSecurityReport({
        audit: auditWith([NOT_MITIGATED_EXAMPLE]),
        isKiloClaw: true,
        content,
      });

      expect(report.markdown).not.toContain('hidden');
      expect(report.markdown).not.toContain('additional finding');
    });
  });

  describe('grade computation', () => {
    const content = buildTestContent();

    function gradeFor(audit: { critical: number; warn: number; info: number }): {
      score: number;
      grade: string;
    } {
      // Build synthetic findings that pass through client severity (no catalog
      // match) so the count lands as specified.
      const findings: AuditFinding[] = [];
      for (let i = 0; i < audit.critical; i++)
        findings.push({
          checkId: `synthetic.crit.${i}`,
          severity: 'critical',
          title: `c${i}`,
          detail: '',
          remediation: null,
        });
      for (let i = 0; i < audit.warn; i++)
        findings.push({
          checkId: `synthetic.warn.${i}`,
          severity: 'warn',
          title: `w${i}`,
          detail: '',
          remediation: null,
        });
      for (let i = 0; i < audit.info; i++)
        findings.push({
          checkId: `synthetic.info.${i}`,
          severity: 'info',
          title: `i${i}`,
          detail: '',
          remediation: null,
        });

      const report = generateSecurityReport({
        audit: {
          ts: 1,
          summary: { critical: audit.critical, warn: audit.warn, info: audit.info },
          findings,
        },
        isKiloClaw: false,
        content,
      });
      return { score: report.score, grade: report.grade };
    }

    it('scores a clean audit as A / 100', () => {
      expect(gradeFor({ critical: 0, warn: 0, info: 0 })).toEqual({ score: 100, grade: 'A' });
    });

    it('info findings do not affect the score', () => {
      expect(gradeFor({ critical: 0, warn: 0, info: 5 })).toEqual({ score: 100, grade: 'A' });
    });

    it('scores the real-world 7-warnings example as C', () => {
      // Baseline calibration: 100 - 4*7 = 72 → C
      expect(gradeFor({ critical: 0, warn: 7, info: 1 })).toEqual({ score: 72, grade: 'C' });
    });

    it('drops a single critical to D', () => {
      expect(gradeFor({ critical: 1, warn: 0, info: 0 })).toEqual({ score: 65, grade: 'D' });
    });

    it('two criticals lands in F territory', () => {
      expect(gradeFor({ critical: 2, warn: 0, info: 0 })).toEqual({ score: 30, grade: 'F' });
    });

    it('clamps extreme finding counts at 0', () => {
      const { score, grade } = gradeFor({ critical: 10, warn: 20, info: 0 });
      expect(score).toBe(0);
      expect(grade).toBe('F');
    });

    it('boundary: 90 is the A/B cutoff', () => {
      // 100 - 4*2 = 92 → A; 100 - 4*3 = 88 → B
      expect(gradeFor({ critical: 0, warn: 2, info: 0 }).grade).toBe('A');
      expect(gradeFor({ critical: 0, warn: 3, info: 0 }).grade).toBe('B');
    });
  });
});
