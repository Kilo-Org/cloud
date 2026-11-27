import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  STATUS_CALLBACK_SCOPE,
  StatusCallbackCredentialError,
  statusCallbackCredential,
} from '../../src/status-callback-auth';

const SECRET = 'synthetic-callback-secret';
const TOKEN = 'synthetic.status.token';
const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = 'attempt-1';
const ctx = { waitUntil: () => {} };

function binding(answer: (request: MintRequest) => MintResult) {
  return { mintTokens: vi.fn(async (request: MintRequest) => answer(request)) };
}

function issued(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued',
      audience,
      scope,
      token: TOKEN,
      jti: 'jti-1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

function denied(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'denied',
      audience,
      scope,
      reason: 'unknown_scope',
    })),
  };
}

const derived = () =>
  deriveCallbackToken({
    secret: SECRET,
    scope: 'code-review-status-callback',
    resourceParts: [REVIEW_ID, ATTEMPT_ID],
  });

describe('CODE_REVIEW_STATUS_CALLBACK_AUTH', () => {
  it.each([undefined, '', 'legacy'])(
    '%j sends the derived callback token, as before, and mints nothing',
    async mode => {
      const sts = binding(issued);
      const credential = await statusCallbackCredential(
        { CALLBACK_TOKEN_SECRET: SECRET, CODE_REVIEW_STATUS_CALLBACK_AUTH: mode, STS: sts },
        ctx,
        REVIEW_ID,
        ATTEMPT_ID
      );
      expect(credential).toEqual({ headers: { 'X-Callback-Token': await derived() } });
      expect(sts.mintTokens).not.toHaveBeenCalled();
    }
  );

  it('sts sends only a web:code-review.status-callback token, never the derived token', async () => {
    const sts = binding(issued);
    const credential = await statusCallbackCredential(
      { CALLBACK_TOKEN_SECRET: SECRET, CODE_REVIEW_STATUS_CALLBACK_AUTH: 'sts', STS: sts },
      ctx,
      REVIEW_ID,
      ATTEMPT_ID
    );
    expect(credential).toEqual({
      headers: { Authorization: `Bearer ${TOKEN}` },
      redirect: 'error',
    });
    expect(sts.mintTokens).toHaveBeenCalledWith({ tokens: [STATUS_CALLBACK_SCOPE] });
    expect(STATUS_CALLBACK_SCOPE).toEqual({
      audience: 'web',
      scope: 'web:code-review.status-callback',
    });
  });

  it('a denied mint refuses the write with its closed reason', async () => {
    const write = statusCallbackCredential(
      {
        CALLBACK_TOKEN_SECRET: SECRET,
        CODE_REVIEW_STATUS_CALLBACK_AUTH: 'sts',
        STS: binding(denied),
      },
      ctx,
      REVIEW_ID,
      ATTEMPT_ID
    );
    await expect(write).rejects.toBeInstanceOf(StatusCallbackCredentialError);
    await expect(write).rejects.toMatchObject({ reason: 'denied', deniedReason: 'unknown_scope' });
  });

  it('sts without the STS binding refuses the write', async () => {
    await expect(
      statusCallbackCredential(
        { CALLBACK_TOKEN_SECRET: SECRET, CODE_REVIEW_STATUS_CALLBACK_AUTH: 'sts' },
        ctx,
        REVIEW_ID,
        ATTEMPT_ID
      )
    ).rejects.toMatchObject({ reason: 'sts_binding_missing' });
  });

  it.each(['STS', 'dual', 'secrets-store', ' '])('refuses %j', async mode => {
    const sts = binding(issued);
    await expect(
      statusCallbackCredential(
        { CALLBACK_TOKEN_SECRET: SECRET, CODE_REVIEW_STATUS_CALLBACK_AUTH: mode, STS: sts },
        ctx,
        REVIEW_ID,
        ATTEMPT_ID
      )
    ).rejects.toMatchObject({ reason: 'invalid_auth' });
    expect(sts.mintTokens).not.toHaveBeenCalled();
  });
});
