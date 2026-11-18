import { getPostgresErrorCode, isUniqueViolation } from '@/lib/db-errors';

describe('getPostgresErrorCode', () => {
  it('reads the code from a direct error', () => {
    expect(getPostgresErrorCode({ code: '23505' })).toBe('23505');
  });

  it('walks the cause chain to the wrapped driver error', () => {
    const error = new Error('Failed query');
    Object.assign(error, { cause: { code: '23505' } });
    expect(getPostgresErrorCode(error)).toBe('23505');
  });

  it('returns null for non-objects', () => {
    expect(getPostgresErrorCode(null)).toBeNull();
    expect(getPostgresErrorCode('23505')).toBeNull();
  });

  it('ignores non-SQLSTATE code fields', () => {
    expect(getPostgresErrorCode({ code: 'ENOTFOUND' })).toBeNull();
  });

  it('returns null when no code exists in the chain', () => {
    expect(getPostgresErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('isUniqueViolation', () => {
  it('is true for a direct unique-violation error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is true when the violation is wrapped', () => {
    const error = new Error('Failed query');
    Object.assign(error, { cause: { code: '23505' } });
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('is false for other SQLSTATE codes', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation({ code: '40001' })).toBe(false);
  });

  it('is false for non-database errors', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
