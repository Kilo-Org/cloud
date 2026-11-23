import { describe, expect, test } from '@jest/globals';
import { reportedAuthError } from './reported-auth-error';

describe('reportedAuthError', () => {
  test('keeps the SQLSTATE of a storage failure', () => {
    const storageError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      { code: '23505' }
    );

    const reported = reportedAuthError('OpenAI session creation failed', storageError);

    expect(reported.message).toBe('OpenAI session creation failed');
    expect(reported.cause).toEqual({ code: '23505', name: 'Error' });
    expect(JSON.stringify(reported.cause)).not.toContain('users_email_unique');
  });

  test('distinguishes another failure from a storage failure', () => {
    const reported = reportedAuthError('OpenAI session creation failed', new TypeError('bad'));

    expect(reported.cause).toEqual({ name: 'TypeError' });
  });

  test('reads a SQLSTATE from a wrapped cause', () => {
    const wrapped = new Error('wrapped', { cause: { code: '23503' } });

    expect(reportedAuthError('failed', wrapped).cause).toEqual({ code: '23503', name: 'Error' });
  });

  test('drops a value that is not a SQLSTATE', () => {
    const error = Object.assign(new Error('secret-subject'), { code: 'ECONNREFUSED' });

    expect(reportedAuthError('failed', error).cause).toEqual({ name: 'Error' });
  });

  test('keeps the class name of a non-Error value', () => {
    expect(reportedAuthError('failed', 'secret-subject').cause).toEqual({ name: 'string' });
  });
});
