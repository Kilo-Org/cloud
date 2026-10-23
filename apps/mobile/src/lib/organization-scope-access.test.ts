import { describe, expect, it } from 'vitest';

import { classifyOrganizationScopeAccess } from './organization-scope-access';

const denied = (code: string, extra: Record<string, unknown> = {}) => ({
  data: { code, httpStatus: code === 'NOT_FOUND' ? 404 : 401, ...extra },
});

function accessFor(patch: { isOrganizationScope?: boolean; errors?: readonly unknown[] }) {
  return classifyOrganizationScopeAccess({
    isOrganizationScope: true,
    errors: [],
    ...patch,
  });
}

describe('classifyOrganizationScopeAccess', () => {
  it('grants a personal scope and never reads it as a denial', () => {
    expect(accessFor({ isOrganizationScope: false, errors: [denied('UNAUTHORIZED')] })).toBe(
      'granted'
    );
  });

  it('grants while the scope has no error', () => {
    expect(accessFor({})).toBe('granted');
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('denies on a %s report', code => {
    expect(accessFor({ errors: [denied(code)] })).toBe('denied');
  });

  it('reports a deleted organization as not-found', () => {
    expect(accessFor({ errors: [denied('NOT_FOUND')] })).toBe('not-found');
  });

  it('keeps a denial that arrives beside cached data', () => {
    expect(accessFor({ errors: [undefined, denied('FORBIDDEN')] })).toBe('denied');
  });

  it('reads a shaped server error', () => {
    expect(accessFor({ errors: [{ shape: { data: { code: 'FORBIDDEN' } } }] })).toBe('denied');
  });

  it('does not treat a session-level unauthorized response as lost access', () => {
    expect(accessFor({ errors: [denied('UNAUTHORIZED', { authRequired: true })] })).toBe('granted');
  });

  it('prefers a denial over a not-found report', () => {
    expect(accessFor({ errors: [denied('NOT_FOUND'), denied('UNAUTHORIZED')] })).toBe('denied');
  });

  it('ignores unrelated error codes', () => {
    expect(
      accessFor({ errors: [denied('INTERNAL_SERVER_ERROR'), denied('TIMEOUT'), undefined] })
    ).toBe('granted');
  });
});
