import { describe, expect, it } from 'vitest';
import { normalizeOrganizationId } from './organization-normalization';

describe('normalizeOrganizationId()', () => {
  it('returns null for undefined', () => {
    const undefinedInput: string | undefined = undefined;
    expect(normalizeOrganizationId(undefinedInput)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeOrganizationId('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeOrganizationId('   ')).toBeNull();
  });

  it('returns the string for a non-empty value', () => {
    expect(normalizeOrganizationId('org-123')).toBe('org-123');
  });

  it('preserves the original string including surrounding spaces for a valid ID', () => {
    expect(normalizeOrganizationId('  org-456  ')).toBe('  org-456  ');
  });
});
