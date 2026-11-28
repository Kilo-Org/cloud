import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { describe, expect, it, vi } from 'vitest';
import { readStsToken, senderAuth } from './sts-sender.js';

const TARGET = { audience: 'web', scope: 'web:glanceable-snapshot.read' } as const;
const MINTED = 'minted.sender.token';

function binding(answer: (request: MintRequest) => MintResult) {
  return { mintTokens: vi.fn(async (request: MintRequest) => answer(request)) };
}

function issue(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued' as const,
      audience,
      scope,
      token: MINTED,
      jti: 'jti-sender',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

describe('senderAuth', () => {
  it.each([
    [undefined, 'legacy'],
    ['', 'legacy'],
    ['legacy', 'legacy'],
    ['sts', 'sts'],
  ] as const)('reads %j as %s', (value, mode) => {
    expect(senderAuth(value)).toBe(mode);
  });

  it.each(['STS', 'Legacy', 'secrets-store', 'both', ' sts'])('refuses %j', value => {
    expect(senderAuth(value)).toBeNull();
  });
});

describe('readStsToken', () => {
  it('mints once and serves the held token after that', async () => {
    const sts = binding(issue);

    expect(await readStsToken(sts, TARGET)).toEqual({ kind: 'token', token: MINTED });
    expect(await readStsToken(sts, TARGET)).toEqual({ kind: 'token', token: MINTED });
    expect(sts.mintTokens).toHaveBeenCalledTimes(1);
    expect(sts.mintTokens).toHaveBeenCalledWith({ tokens: [TARGET] });
  });

  it('hands a renewal to the invocation it is given', async () => {
    const waitUntil = vi.fn();

    expect(await readStsToken(binding(issue), TARGET, { waitUntil })).toEqual({
      kind: 'token',
      token: MINTED,
    });
  });

  it('reports a missing binding, a denial and an unanswered mint without a token', async () => {
    expect(await readStsToken(undefined, TARGET)).toEqual({
      kind: 'unavailable',
      reason: 'sts_binding_missing',
    });
    const denied = binding(request => ({
      status: 'ok',
      tokens: request.tokens.map(({ audience, scope }) => ({
        status: 'denied' as const,
        audience,
        scope,
        reason: 'unknown_scope' as const,
      })),
    }));
    expect(await readStsToken(denied, TARGET)).toEqual({
      kind: 'unavailable',
      reason: 'token_denied',
      deniedReason: 'unknown_scope',
    });
    expect(
      await readStsToken(
        binding(() => ({ status: 'unavailable', retryAfterSeconds: 5 })),
        TARGET
      )
    ).toEqual({ kind: 'unavailable', reason: 'token_unavailable' });
  });
});
