import type { OrganizationGuardrailConfig } from '@kilocode/db/schema-types';
import { versionSpecLabel } from './guardrail-display';

function packageConfig(
  overrides: { version_spec?: string | null; version_spec_invalid?: boolean } = {}
): OrganizationGuardrailConfig {
  return {
    kind: 'package',
    ecosystem: 'npm',
    identifier: 'pkg',
    version_spec: null,
    ...overrides,
  };
}

describe('versionSpecLabel', () => {
  it('shows the range', () => {
    expect(versionSpecLabel(packageConfig({ version_spec: '>=1.2.3' }))).toBe('>=1.2.3');
  });

  it('shows "Any version" for an unrestricted package', () => {
    expect(versionSpecLabel(packageConfig())).toBe('Any version');
  });

  it('shows "Needs attention" for an invalid stored rule', () => {
    expect(versionSpecLabel(packageConfig({ version_spec_invalid: true }))).toBe('Needs attention');
  });

  it('shows "Not applicable" for a remote server', () => {
    expect(versionSpecLabel({ kind: 'remote', url: 'https://mcp.example.com/mcp' })).toBe(
      'Not applicable'
    );
  });
});
