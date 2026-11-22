import { DrizzleQueryError } from 'drizzle-orm';
import {
  getPostgresErrorCode,
  getUniqueViolationConstraint,
  isUniqueViolation,
} from '@/lib/db-errors';

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

describe('getUniqueViolationConstraint', () => {
  /** A `pg` driver error: SQLSTATE and index name on the same object. */
  function driverError(
    code: string,
    constraint: string,
    message = 'duplicate key value violates unique constraint'
  ): Error {
    const error = new Error(message);
    return Object.assign(error, { code, constraint });
  }

  it('names the index of a direct unique-violation error', () => {
    const error = driverError('23505', 'UQ_agent_env_profiles_user_name');
    expect(getUniqueViolationConstraint(error)).toBe('UQ_agent_env_profiles_user_name');
  });

  it('walks two cause levels to the driver error Drizzle wraps', () => {
    const wrapped = new DrizzleQueryError(
      'insert into "agent_environment_profile_vars" values ($1, $2)',
      ['profile', 'API_KEY'],
      driverError('23505', 'UQ_agent_env_profile_vars_profile_key')
    );
    const error = new Error('createProfileWithContent failed', { cause: wrapped });

    expect(getUniqueViolationConstraint(error)).toBe('UQ_agent_env_profile_vars_profile_key');
  });

  it('returns null when the violation names no index', () => {
    const error = new Error('Failed query', { cause: { code: '23505' } });
    expect(getUniqueViolationConstraint(error)).toBeNull();
  });

  it('returns null for another SQLSTATE even when it carries a constraint', () => {
    const error = driverError('23503', 'FK_agent_env_profile_vars');
    expect(getUniqueViolationConstraint(error)).toBeNull();
  });

  it('returns null for a bare error', () => {
    expect(getUniqueViolationConstraint(new Error('boom'))).toBeNull();
    expect(getUniqueViolationConstraint(null)).toBeNull();
  });
});
