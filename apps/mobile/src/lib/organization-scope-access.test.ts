import { describe, expect, it } from 'vitest';

import { classifyOrganizationScopeAccess } from './organization-scope-access';

const denial = (code: string) => ({ data: { code } });

function accessFor(patch: {
  organizationId?: string | undefined;
  membershipIds?: readonly string[] | undefined;
  errors?: readonly ({ data?: { code?: string } } | null | undefined)[];
}) {
  return classifyOrganizationScopeAccess({
    organizationId: 'org-1',
    membershipIds: ['org-1'],
    errors: [],
    ...patch,
  });
}

describe('classifyOrganizationScopeAccess', () => {
  it('grants the personal scope and never reads it as a denial', () => {
    expect(
      accessFor({ organizationId: undefined, membershipIds: [], errors: [denial('UNAUTHORIZED')] })
    ).toBe('granted');
  });

  it('grants a current membership', () => {
    expect(accessFor({})).toBe('granted');
  });

  it('denies an organization the settled membership list no longer contains', () => {
    expect(accessFor({ membershipIds: ['org-2'] })).toBe('denied');
  });

  it('grants while the membership list has not settled', () => {
    expect(accessFor({ membershipIds: undefined })).toBe('granted');
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'])(
    'denies on a %s report from an organization query',
    code => {
      expect(accessFor({ errors: [denial(code)] })).toBe('denied');
    }
  );

  it('reports a deleted organization as not-found', () => {
    expect(accessFor({ errors: [denial('NOT_FOUND')] })).toBe('not-found');
  });

  it('keeps a denial whose query still carries cached data', () => {
    expect(
      accessFor({ membershipIds: ['org-1'], errors: [undefined, denial('FORBIDDEN')] })
    ).toBe('denied');
  });

  it('prefers a denial over a not-found report', () => {
    expect(accessFor({ errors: [denial('NOT_FOUND'), denial('UNAUTHORIZED')] })).toBe('denied');
  });

  it('ignores unrelated error codes', () => {
    expect(accessFor({ errors: [denial('INTERNAL_SERVER_ERROR'), denial('TIMEOUT')] })).toBe(
      'granted'
    );
  });
});
