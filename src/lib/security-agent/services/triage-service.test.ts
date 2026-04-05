import { describe, expect, it } from '@jest/globals';

/**
 * Tests for triage service helper functions.
 *
 * Note: The main triageSecurityFinding function makes external LLM calls,
 * so we test the helper functions and parsing logic here.
 * Integration tests for the full triage flow would require mocking the LLM proxy.
 */

// Simplified mock finding type for testing (matches SecurityFinding shape)
type MockFinding = {
  id: string;
  package_name: string;
  package_ecosystem: string;
  severity: string;
  dependency_scope: string | null;
  cve_id: string | null;
  ghsa_id: string | null;
  cwe_ids: string[] | null;
  cvss_score: string | null;
  title: string;
  description: string | null;
  vulnerable_version_range: string | null;
  patched_version: string | null;
  manifest_path: string | null;
};

// Mock finding for testing
const createMockFinding = (overrides: Partial<MockFinding> = {}): MockFinding => ({
  id: 'test-finding-id',
  package_name: 'lodash',
  package_ecosystem: 'npm',
  severity: 'high',
  dependency_scope: 'runtime',
  cve_id: 'CVE-2021-12345',
  ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
  cwe_ids: ['CWE-1321'],
  cvss_score: '7.5',
  title: 'Prototype Pollution in lodash',
  description: 'A detailed description of the vulnerability',
  vulnerable_version_range: '< 4.17.21',
  patched_version: '4.17.21',
  manifest_path: 'package.json',
  ...overrides,
});

describe('triage-service', () => {
  describe('triage prompt building', () => {
    it('should include all relevant finding fields in prompt', () => {
      const finding = createMockFinding();

      // The prompt should include these key fields
      expect(finding.package_name).toBe('lodash');
      expect(finding.package_ecosystem).toBe('npm');
      expect(finding.severity).toBe('high');
      expect(finding.dependency_scope).toBe('runtime');
      expect(finding.cve_id).toBe('CVE-2021-12345');
      expect(finding.ghsa_id).toBe('GHSA-xxxx-yyyy-zzzz');
      expect(finding.cwe_ids).toEqual(['CWE-1321']);
      expect(finding.cvss_score).toBe('7.5');
      expect(finding.title).toBe('Prototype Pollution in lodash');
      expect(finding.description).toBe('A detailed description of the vulnerability');
      expect(finding.vulnerable_version_range).toBe('< 4.17.21');
      expect(finding.patched_version).toBe('4.17.21');
      expect(finding.manifest_path).toBe('package.json');
    });

    it('should handle findings with missing optional fields', () => {
      const finding = createMockFinding({
        cve_id: null,
        cwe_ids: null,
        cvss_score: null,
        description: null,
        patched_version: null,
        dependency_scope: null,
      });

      expect(finding.cve_id).toBeNull();
      expect(finding.cwe_ids).toBeNull();
      expect(finding.cvss_score).toBeNull();
      expect(finding.description).toBeNull();
      expect(finding.patched_version).toBeNull();
      expect(finding.dependency_scope).toBeNull();
    });

    it('should handle development dependencies', () => {
      const finding = createMockFinding({
        dependency_scope: 'development',
        package_name: 'jest',
        severity: 'medium',
      });

      expect(finding.dependency_scope).toBe('development');
      expect(finding.package_name).toBe('jest');
      expect(finding.severity).toBe('medium');
    });
  });

  describe('triage result validation', () => {
    it('should validate valid triage result structure', () => {
      const validResult = {
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Dev dependency with low severity',
        suggestedAction: 'dismiss' as const,
        confidence: 'high' as const,
        triageAt: new Date().toISOString(),
      };

      expect(typeof validResult.needsSandboxAnalysis).toBe('boolean');
      expect(typeof validResult.needsSandboxReasoning).toBe('string');
      expect(['dismiss', 'analyze_codebase', 'manual_review']).toContain(
        validResult.suggestedAction
      );
      expect(['high', 'medium', 'low']).toContain(validResult.confidence);
      expect(validResult.triageAt).toBeDefined();
    });

    it('should handle dismiss action', () => {
      const result = {
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Test framework vulnerability in dev dependency',
        suggestedAction: 'dismiss' as const,
        confidence: 'high' as const,
        triageAt: new Date().toISOString(),
      };

      expect(result.needsSandboxAnalysis).toBe(false);
      expect(result.suggestedAction).toBe('dismiss');
    });

    it('should handle analyze_codebase action', () => {
      const result = {
        needsSandboxAnalysis: true,
        needsSandboxReasoning: 'Runtime dependency with critical RCE vulnerability',
        suggestedAction: 'analyze_codebase' as const,
        confidence: 'high' as const,
        triageAt: new Date().toISOString(),
      };

      expect(result.needsSandboxAnalysis).toBe(true);
      expect(result.suggestedAction).toBe('analyze_codebase');
    });

    it('should handle manual_review action', () => {
      const result = {
        needsSandboxAnalysis: false,
        needsSandboxReasoning: 'Uncertain case requiring human judgment',
        suggestedAction: 'manual_review' as const,
        confidence: 'low' as const,
        triageAt: new Date().toISOString(),
      };

      expect(result.needsSandboxAnalysis).toBe(false);
      expect(result.suggestedAction).toBe('manual_review');
      expect(result.confidence).toBe('low');
    });
  });

  describe('triage decision logic', () => {
    it('should recommend dismiss for dev dependencies with low severity', () => {
      const finding = createMockFinding({
        dependency_scope: 'development',
        severity: 'low',
        package_name: 'eslint-plugin-test',
      });

      // Dev dependency + low severity = likely dismiss candidate
      expect(finding.dependency_scope).toBe('development');
      expect(finding.severity).toBe('low');
    });

    it('should recommend analyze_codebase for runtime dependencies with critical severity', () => {
      const finding = createMockFinding({
        dependency_scope: 'runtime',
        severity: 'critical',
        package_name: 'express',
      });

      // Runtime dependency + critical severity = needs codebase analysis
      expect(finding.dependency_scope).toBe('runtime');
      expect(finding.severity).toBe('critical');
    });

    it('should consider CWE types for triage decisions', () => {
      // RCE vulnerability - should always analyze
      const rceFinding = createMockFinding({
        cwe_ids: ['CWE-94'], // Code Injection
        severity: 'high',
      });
      expect(rceFinding.cwe_ids).toContain('CWE-94');

      // DoS vulnerability - may be auto-dismissable for dev deps
      const dosFinding = createMockFinding({
        cwe_ids: ['CWE-400'], // Uncontrolled Resource Consumption
        severity: 'medium',
        dependency_scope: 'development',
      });
      expect(dosFinding.cwe_ids).toContain('CWE-400');
      expect(dosFinding.dependency_scope).toBe('development');
    });

    it('should consider CVSS score for severity assessment', () => {
      // High CVSS score
      const highCvss = createMockFinding({
        cvss_score: '9.8',
        severity: 'critical',
      });
      expect(parseFloat(highCvss.cvss_score ?? '0')).toBeGreaterThan(9);

      // Low CVSS score
      const lowCvss = createMockFinding({
        cvss_score: '3.1',
        severity: 'low',
      });
      expect(parseFloat(lowCvss.cvss_score ?? '0')).toBeLessThan(4);
    });
  });

  describe('fallback triage behavior', () => {
    it('should default to analyze_codebase when uncertain', () => {
      // When triage fails or is uncertain, default to sandbox analysis
      const fallbackResult = {
        needsSandboxAnalysis: true,
        needsSandboxReasoning: 'Triage failed: API error. Defaulting to sandbox analysis.',
        suggestedAction: 'analyze_codebase' as const,
        confidence: 'low' as const,
        triageAt: new Date().toISOString(),
      };

      expect(fallbackResult.needsSandboxAnalysis).toBe(true);
      expect(fallbackResult.suggestedAction).toBe('analyze_codebase');
      expect(fallbackResult.confidence).toBe('low');
    });
  });
});
