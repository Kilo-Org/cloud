import { describe, expect, it } from '@jest/globals';
import { TRPCError } from '@trpc/server';

import {
  APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
  APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE,
  GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE,
  GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE,
  assertAppStoreAccountTokenMatchesUser,
  assertGooglePlayAccountTokenMatchesUser,
} from './store-account-token';

function captureError(run: () => void): TRPCError {
  try {
    run();
  } catch (error) {
    if (error instanceof TRPCError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the assertion to throw');
}

describe('assertAppStoreAccountTokenMatchesUser', () => {
  it('passes when the token matches the signed-in user', () => {
    expect(() =>
      assertAppStoreAccountTokenMatchesUser({
        appAccountToken: 'token-1',
        userAppStoreAccountToken: 'token-1',
      })
    ).not.toThrow();
  });

  it('rejects a null token with the not-linked message', () => {
    const error = captureError(() =>
      assertAppStoreAccountTokenMatchesUser({
        appAccountToken: null,
        userAppStoreAccountToken: 'token-1',
      })
    );

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(APP_STORE_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE);
  });

  it('rejects a different token with the mismatch message', () => {
    const error = captureError(() =>
      assertAppStoreAccountTokenMatchesUser({
        appAccountToken: 'token-2',
        userAppStoreAccountToken: 'token-1',
      })
    );

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE);
  });

  it('uses the requested code for a different token', () => {
    const error = captureError(() =>
      assertAppStoreAccountTokenMatchesUser({
        appAccountToken: 'token-2',
        userAppStoreAccountToken: 'token-1',
        code: 'FORBIDDEN',
      })
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(APP_STORE_ACCOUNT_TOKEN_MISMATCH_MESSAGE);
  });
});

describe('assertGooglePlayAccountTokenMatchesUser', () => {
  it('passes when the token matches the signed-in user', () => {
    expect(() =>
      assertGooglePlayAccountTokenMatchesUser({
        appAccountToken: 'token-1',
        userAppStoreAccountToken: 'token-1',
      })
    ).not.toThrow();
  });

  it('rejects a null token with the not-linked message', () => {
    const error = captureError(() =>
      assertGooglePlayAccountTokenMatchesUser({
        appAccountToken: null,
        userAppStoreAccountToken: 'token-1',
      })
    );

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(GOOGLE_PLAY_PURCHASE_NOT_LINKED_TO_ACCOUNT_MESSAGE);
  });

  it('rejects a different token with the mismatch message', () => {
    const error = captureError(() =>
      assertGooglePlayAccountTokenMatchesUser({
        appAccountToken: 'token-2',
        userAppStoreAccountToken: 'token-1',
      })
    );

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe(GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE);
  });

  it('uses the requested code for a different token', () => {
    const error = captureError(() =>
      assertGooglePlayAccountTokenMatchesUser({
        appAccountToken: 'token-2',
        userAppStoreAccountToken: 'token-1',
        code: 'FORBIDDEN',
      })
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(GOOGLE_PLAY_ACCOUNT_TOKEN_MISMATCH_MESSAGE);
  });
});
