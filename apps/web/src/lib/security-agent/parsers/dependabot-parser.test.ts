import { describe, expect, it } from '@jest/globals';
import { parseDependabotAlert, parseDependabotAlerts, getAlertsSummary } from './dependabot-parser';
import {
  mapDependabotStateToStatus,
  SecurityFindingStatus,
  type DependabotAlertRaw,
} from '../core/types';

describe('dependabot-parser', () => {
  describe('mapDependabotStateToStatus', () => {
    it('should map open state', () => {
      expect(mapDependabotStateToStatus('open')).toBe(SecurityFindingStatus.OPEN);
    });

    it('should map fixed state', () => {
      expect(mapDependabotStateToStatus('fixed')).toBe(SecurityFindingStatus.FIXED);
    });

    it('should map dismissed state to ignored', () => {
      expect(mapDependabotStateToStatus('dismissed')).toBe(SecurityFindingStatus.IGNORED);
    });

    it('should map auto_dismissed state to ignored', () => {
      expect(mapDependabotStateToStatus('auto_dismissed')).toBe(SecurityFindingStatus.IGNORED);
    });
  });

  describe('parseDependabotAlert', () => {
    const mockAlert: DependabotAlertRaw = {
      number: 123,
      state: 'open',
      dependency: {
        package: {
          ecosystem: 'npm',
          name: 'lodash',
        },
        manifest_path: 'package.json',
        scope: 'runtime',
      },
      security_advisory: {
        ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
        cve_id: 'CVE-2021-12345',
        summary: 'Prototype Pollution in lodash',
        description: 'A detailed description of the vulnerability',
        severity: 'high',
        cvss: {
          score: 7.5,
          vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
        },
        cwes: [
          {
            cwe_id: 'CWE-1321',
            name: 'Improperly Controlled Modification of Object Prototype Attributes',
          },
        ],
      },
      security_vulnerability: {
        vulnerable_version_range: '< 4.17.21',
        first_patched_version: { identifier: '4.17.21' },
      },
      url: 'https://api.github.com/repos/owner/repo/dependabot/alerts/123',
      html_url: 'https://github.com/owner/repo/security/dependabot/123',
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T10:00:00Z',
      dismissed_at: null,
      dismissed_by: null,
      dismissed_reason: null,
      dismissed_comment: null,
      fixed_at: null,
      auto_dismissed_at: null,
    };

    it('should parse a basic Dependabot alert', () => {
      const result = parseDependabotAlert(mockAlert, 'owner/repo');

      expect(result.source).toBe('dependabot');
      expect(result.source_id).toBe('123');
      expect(result.severity).toBe('high');
      expect(result.status).toBe('open');
      expect(result.package_name).toBe('lodash');
      expect(result.package_ecosystem).toBe('npm');
      expect(result.ghsa_id).toBe('GHSA-xxxx-yyyy-zzzz');
      expect(result.cve_id).toBe('CVE-2021-12345');
      expect(result.title).toBe('Prototype Pollution in lodash');
      expect(result.description).toBe('A detailed description of the vulnerability');
      expect(result.vulnerable_version_range).toBe('< 4.17.21');
      expect(result.patched_version).toBe('4.17.21');
      expect(result.manifest_path).toBe('package.json');
      expect(result.dependabot_html_url).toBe(
        'https://github.com/owner/repo/security/dependabot/123'
      );
      // New fields for Phase 2 analysis support
      expect(result.cwe_ids).toEqual(['CWE-1321']);
      expect(result.cvss_score).toBe(7.5);
      expect(result.dependency_scope).toBe('runtime');
    });

    it('should handle fixed alerts', () => {
      const fixedAlert: DependabotAlertRaw = {
        ...mockAlert,
        state: 'fixed',
        fixed_at: '2024-01-20T15:00:00Z',
      };

      const result = parseDependabotAlert(fixedAlert, 'owner/repo');

      expect(result.status).toBe('fixed');
      expect(result.fixed_at).toBe('2024-01-20T15:00:00Z');
    });

    it('should handle dismissed alerts', () => {
      const dismissedAlert: DependabotAlertRaw = {
        ...mockAlert,
        state: 'dismissed',
        dismissed_at: '2024-01-18T12:00:00Z',
        dismissed_by: { login: 'security-team' },
        dismissed_reason: 'not_used',
        dismissed_comment: 'This function is not used in our codebase',
      };

      const result = parseDependabotAlert(dismissedAlert, 'owner/repo');

      expect(result.status).toBe('ignored');
      expect(result.ignored_reason).toBe('not_used');
      expect(result.ignored_by).toBe('security-team');
    });

    it('should handle auto-dismissed alerts', () => {
      const autoDismissedAlert: DependabotAlertRaw = {
        ...mockAlert,
        state: 'auto_dismissed',
        auto_dismissed_at: '2024-01-19T08:00:00Z',
      };

      const result = parseDependabotAlert(autoDismissedAlert, 'owner/repo');

      expect(result.status).toBe('ignored');
    });

    it('should handle alerts without CVE', () => {
      const alertWithoutCve: DependabotAlertRaw = {
        ...mockAlert,
        security_advisory: {
          ...mockAlert.security_advisory,
          cve_id: null,
        },
      };

      const result = parseDependabotAlert(alertWithoutCve, 'owner/repo');

      expect(result.cve_id).toBeNull();
    });

    it('should handle alerts without patched version', () => {
      const alertWithoutPatch: DependabotAlertRaw = {
        ...mockAlert,
        security_vulnerability: {
          ...mockAlert.security_vulnerability,
          first_patched_version: undefined,
        },
      };

      const result = parseDependabotAlert(alertWithoutPatch, 'owner/repo');

      expect(result.patched_version).toBeNull();
    });

    it('should store raw data', () => {
      const result = parseDependabotAlert(mockAlert, 'owner/repo');

      expect(result.raw_data).toEqual(mockAlert);
    });

    it('should handle alerts without CVSS data', () => {
      const alertWithoutCvss: DependabotAlertRaw = {
        ...mockAlert,
        security_advisory: {
          ...mockAlert.security_advisory,
          cvss: undefined,
          cwes: undefined,
        },
      };

      const result = parseDependabotAlert(alertWithoutCvss, 'owner/repo');

      expect(result.cvss_score).toBeNull();
      expect(result.cwe_ids).toBeNull();
    });

    it('should handle development scope dependencies', () => {
      const devDependencyAlert: DependabotAlertRaw = {
        ...mockAlert,
        dependency: {
          ...mockAlert.dependency,
          scope: 'development',
        },
      };

      const result = parseDependabotAlert(devDependencyAlert, 'owner/repo');

      expect(result.dependency_scope).toBe('development');
    });

    it('should extract multiple CWE IDs', () => {
      const alertWithMultipleCwes: DependabotAlertRaw = {
        ...mockAlert,
        security_advisory: {
          ...mockAlert.security_advisory,
          cwes: [
            { cwe_id: 'CWE-79', name: 'Cross-site Scripting' },
            { cwe_id: 'CWE-89', name: 'SQL Injection' },
          ],
        },
      };

      const result = parseDependabotAlert(alertWithMultipleCwes, 'owner/repo');

      expect(result.cwe_ids).toEqual(['CWE-79', 'CWE-89']);
    });
  });

  describe('parseDependabotAlerts', () => {
    it('should parse multiple alerts', () => {
      const alerts: DependabotAlertRaw[] = [
        {
          number: 1,
          state: 'open',
          dependency: {
            package: { ecosystem: 'npm', name: 'package-a' },
            manifest_path: 'package.json',
            scope: 'runtime',
          },
          security_advisory: {
            ghsa_id: 'GHSA-1111-1111-1111',
            cve_id: null,
            summary: 'Vulnerability A',
            description: 'Description A',
            severity: 'critical',
          },
          security_vulnerability: {
            vulnerable_version_range: '< 1.0.0',
            first_patched_version: { identifier: '1.0.0' },
          },
          url: '',
          html_url: '',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          dismissed_at: null,
          dismissed_by: null,
          dismissed_reason: null,
          dismissed_comment: null,
          fixed_at: null,
          auto_dismissed_at: null,
        },
        {
          number: 2,
          state: 'fixed',
          dependency: {
            package: { ecosystem: 'npm', name: 'package-b' },
            manifest_path: 'package.json',
            scope: 'development',
          },
          security_advisory: {
            ghsa_id: 'GHSA-2222-2222-2222',
            cve_id: 'CVE-2024-0001',
            summary: 'Vulnerability B',
            description: 'Description B',
            severity: 'low',
          },
          security_vulnerability: {
            vulnerable_version_range: '< 2.0.0',
            first_patched_version: { identifier: '2.0.0' },
          },
          url: '',
          html_url: '',
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-05T00:00:00Z',
          dismissed_at: null,
          dismissed_by: null,
          dismissed_reason: null,
          dismissed_comment: null,
          fixed_at: '2024-01-05T00:00:00Z',
          auto_dismissed_at: null,
        },
      ];

      const results = parseDependabotAlerts(alerts, 'owner/repo');

      expect(results).toHaveLength(2);
      expect(results[0].package_name).toBe('package-a');
      expect(results[0].severity).toBe('critical');
      expect(results[0].status).toBe('open');
      expect(results[1].package_name).toBe('package-b');
      expect(results[1].severity).toBe('low');
      expect(results[1].status).toBe('fixed');
    });

    it('should return empty array for empty input', () => {
      const results = parseDependabotAlerts([], 'owner/repo');
      expect(results).toHaveLength(0);
    });
  });

  describe('getAlertsSummary', () => {
    it('should calculate summary statistics', () => {
      const findings = [
        { severity: 'critical', status: 'open' },
        { severity: 'high', status: 'open' },
        { severity: 'high', status: 'fixed' },
        { severity: 'medium', status: 'ignored' },
        { severity: 'low', status: 'open' },
      ] as Parameters<typeof getAlertsSummary>[0];

      const summary = getAlertsSummary(findings);

      expect(summary.total).toBe(5);
      expect(summary.bySeverity.critical).toBe(1);
      expect(summary.bySeverity.high).toBe(2);
      expect(summary.bySeverity.medium).toBe(1);
      expect(summary.bySeverity.low).toBe(1);
      expect(summary.byStatus.open).toBe(3);
      expect(summary.byStatus.fixed).toBe(1);
      expect(summary.byStatus.ignored).toBe(1);
    });

    it('should handle empty array', () => {
      const summary = getAlertsSummary([]);

      expect(summary.total).toBe(0);
      expect(summary.bySeverity.critical).toBe(0);
      expect(summary.byStatus.open).toBe(0);
    });
  });
});
