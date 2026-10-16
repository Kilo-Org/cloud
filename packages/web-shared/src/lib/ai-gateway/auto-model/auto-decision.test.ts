import { describe, expect, it } from '@jest/globals';
import { signAutoDecision, type AutoDecisionPayload } from '@kilocode/auto-routing-contracts';
import { checkAutoDecision } from './auto-decision';

const SECRET = 'test-decision-secret';
const NOW = 1_800_000_000_000;

const payload: AutoDecisionPayload = {
  userId: 'user-1',
  organizationId: 'org-1',
  routerModelId: 'kilo-auto/custom/org/team',
  model: 'anthropic/claude-haiku-4.5',
  variant: 'max',
  expiresAt: NOW + 60_000,
};

const request: {
  secret: string;
  nowMs: number;
  userId: string;
  organizationId: string | null;
  model: string;
} = {
  secret: SECRET,
  nowMs: NOW,
  userId: 'user-1',
  organizationId: 'org-1',
  model: 'anthropic/claude-haiku-4.5',
};

async function check(overrides: Partial<typeof request> = {}, signed = payload) {
  return checkAutoDecision({
    ...request,
    token: await signAutoDecision(signed, SECRET),
    ...overrides,
  });
}

describe('checkAutoDecision', () => {
  it('accepts a matching decision and serves its signed variant', async () => {
    expect(await check()).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: {
        model: 'anthropic/claude-haiku-4.5',
        reasoning: { enabled: true, effort: 'max' },
        verbosity: 'max',
      },
    });
  });

  it('matches the model id case-insensitively and serves the signed id', async () => {
    const result = await check({ model: 'Anthropic/Claude-Haiku-4.5' });
    expect(result).toMatchObject({ kind: 'ok', resolved: { model: 'anthropic/claude-haiku-4.5' } });
  });

  it('serves a null variant without catalog settings', async () => {
    expect(await check({}, { ...payload, variant: null })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: 'anthropic/claude-haiku-4.5' },
    });
  });

  it('rejects a tampered token', async () => {
    const token = await signAutoDecision(payload, SECRET);
    const [version, body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...payload, model: 'openai/gpt-5' }),
      'utf8'
    ).toString('base64url');
    expect(body).not.toBe(forged);

    expect(
      await checkAutoDecision({
        ...request,
        model: 'openai/gpt-5',
        token: `${version}.${forged}.${signature}`,
      })
    ).toEqual({ kind: 'rejected', reason: 'bad_signature' });
  });

  it('rejects a token signed with another secret', async () => {
    expect(
      await checkAutoDecision({
        ...request,
        token: await signAutoDecision(payload, 'another-secret'),
      })
    ).toEqual({ kind: 'rejected', reason: 'bad_signature' });
  });

  it('rejects a malformed token', async () => {
    expect(await checkAutoDecision({ ...request, token: 'not-a-token' })).toEqual({
      kind: 'rejected',
      reason: 'malformed',
    });
  });

  it('rejects an expired token', async () => {
    expect(await check({ nowMs: payload.expiresAt })).toEqual({
      kind: 'rejected',
      reason: 'expired',
    });
  });

  it('rejects a token for another user', async () => {
    expect(await check({ userId: 'user-2' })).toEqual({
      kind: 'rejected',
      reason: 'user_mismatch',
    });
  });

  it.each([
    ['another organization', 'org-2'],
    ['no organization context', null],
  ])('rejects a token issued in %s', async (_name, organizationId) => {
    expect(await check({ organizationId })).toEqual({
      kind: 'rejected',
      reason: 'organization_mismatch',
    });
  });

  it('rejects a token for another model', async () => {
    expect(await check({ model: 'openai/gpt-5' })).toEqual({
      kind: 'rejected',
      reason: 'model_mismatch',
    });
  });

  it('rejects a signed variant missing from the catalog', async () => {
    expect(
      await check(
        { model: 'anthropic/claude-sonnet-5' },
        { ...payload, model: 'anthropic/claude-sonnet-5', variant: 'thinking' }
      )
    ).toEqual({ kind: 'rejected', reason: 'variant_unavailable' });
  });

  it('rejects a decision for a client entry the CLI serves itself', async () => {
    const clientModel = 'client:ollama/qwen3:32b';
    expect(
      await check({ model: clientModel }, { ...payload, model: clientModel, variant: null })
    ).toEqual({ kind: 'rejected', reason: 'client_entry' });
  });
});
