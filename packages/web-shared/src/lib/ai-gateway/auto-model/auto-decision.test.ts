import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  signAutoDecision,
  type AutoDecisionPayload,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import { findCustomRouter } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { readLatestAliasTargets } from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { checkAutoDecision } from './auto-decision';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets'
  ),
  readLatestAliasTargets: jest.fn(),
}));

const mockedFindCustomRouter = jest.mocked(findCustomRouter);
const mockedReadLatestAliasTargets = jest.mocked(readLatestAliasTargets);
const TX = { name: 'tx' };
let transactionSpy: jest.SpiedFunction<typeof db.transaction>;

const SECRET = 'test-decision-secret';
const NOW = 1_800_000_000_000;

const HAIKU = 'anthropic/claude-haiku-4.5';
const SONNET = 'anthropic/claude-sonnet-4.5';
const MOVED = 'anthropic/claude-opus-4-6';
const ALIAS = '~anthropic/claude-sonnet-latest';
const PINNED_AT = '2026-11-20T00:00:00.000Z';

const payload: AutoDecisionPayload = {
  userId: 'user-1',
  organizationId: 'org-1',
  routerModelId: 'kilo-auto/custom/org/team',
  model: HAIKU,
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
  model: HAIKU,
};

const teamPool: CustomRouterDefinition = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerType: 'org',
  ownerId: 'org-1',
  slug: 'team',
  name: 'Team',
  baseRouter: 'frontier',
  mode: 'best_accuracy',
  entries: [
    { kind: 'gateway', model: HAIKU },
    { kind: 'gateway', model: 'anthropic/claude-sonnet-5' },
    { kind: 'gateway', model: ALIAS },
  ],
  defaultEntryKey: `gateway:${HAIKU}`,
};

const pinnedPool: CustomRouterDefinition = {
  ...teamPool,
  entries: [
    { kind: 'gateway', model: HAIKU },
    {
      kind: 'gateway',
      model: ALIAS,
      servingPin: {
        model: SONNET,
        pinnedAt: PINNED_AT,
        requestId: '00000000-0000-4000-8000-000000000002',
        confirmedAt: PINNED_AT,
      },
    },
  ],
  defaultEntryKey: `gateway:${ALIAS}`,
};

function aliasTargets(target: string | null) {
  return target === null ? new Map() : new Map([[ALIAS, { alias: ALIAS, target }]]);
}

async function check(
  overrides: Partial<typeof request> = {},
  signed: Partial<AutoDecisionPayload> = {}
) {
  return checkAutoDecision({
    ...request,
    token: await signAutoDecision({ ...payload, ...signed }, SECRET),
    ...overrides,
  });
}

async function checkSigned(signed: Partial<AutoDecisionPayload>, model = signed.model ?? HAIKU) {
  return check({ model }, { variant: null, ...signed });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindCustomRouter.mockResolvedValue(teamPool);
  mockedReadLatestAliasTargets.mockResolvedValue(new Map());
  transactionSpy = jest
    .spyOn(db, 'transaction')
    .mockImplementation(
      (async (callback: (tx: unknown) => Promise<unknown>) =>
        await callback(TX)) as typeof db.transaction
    );
});

afterEach(() => {
  transactionSpy.mockRestore();
});

describe('checkAutoDecision', () => {
  it('accepts a matching decision and serves its signed variant', async () => {
    expect(await check()).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: {
        model: HAIKU,
        reasoning: { enabled: true, effort: 'max' },
        verbosity: 'max',
      },
    });
  });

  it('matches the model id case-insensitively and serves the signed id', async () => {
    const result = await check({ model: 'Anthropic/Claude-Haiku-4.5' });
    expect(result).toMatchObject({ kind: 'ok', resolved: { model: HAIKU } });
  });

  it('serves a null variant without catalog settings', async () => {
    expect(await check({}, { variant: null })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: HAIKU },
    });
  });

  it('re-checks the saved pool on the primary before serving it', async () => {
    await check();

    const [call] = mockedFindCustomRouter.mock.calls;
    expect(call?.[0]).toEqual({ type: 'org', id: 'org-1' });
    expect(call?.[1]).toBe('team');
    expect(call?.[2] === db).toBe(true);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('skips the pool read for a token that names no custom router', async () => {
    expect(await checkSigned({ routerModelId: 'kilo-auto/efficient', model: HAIKU })).toMatchObject(
      { kind: 'ok' }
    );
    expect(mockedFindCustomRouter).not.toHaveBeenCalled();
  });

  it('refuses pool identity on a token that names no custom router', async () => {
    expect(
      await checkSigned({ routerModelId: 'kilo-auto/efficient', model: HAIKU, entryModel: HAIKU })
    ).toEqual({ kind: 'rejected', reason: 'pool_mismatch' });
    expect(mockedFindCustomRouter).not.toHaveBeenCalled();
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
        { model: 'anthropic/claude-sonnet-5', variant: 'thinking' }
      )
    ).toEqual({ kind: 'rejected', reason: 'variant_unavailable' });
  });

  it('rejects a decision for a client entry the CLI serves itself', async () => {
    const clientModel = 'client:ollama/qwen3:32b';
    expect(await check({ model: clientModel }, { model: clientModel, variant: null })).toEqual({
      kind: 'rejected',
      reason: 'client_entry',
    });
    expect(mockedFindCustomRouter).not.toHaveBeenCalled();
  });

  it('rejects a decision that names an auto model instead of a pool entry', async () => {
    const autoModel = 'kilo-auto/custom/mine';
    expect(await check({ model: autoModel }, { model: autoModel, variant: null })).toEqual({
      kind: 'rejected',
      reason: 'auto_model',
    });
  });

  it('rejects a pool the owner no longer has', async () => {
    mockedFindCustomRouter.mockResolvedValue(null);

    expect(await check()).toEqual({ kind: 'rejected', reason: 'pool_mismatch' });
  });

  it('reads a personal pool as the authenticated user, not an id the token names', async () => {
    expect(
      await checkSigned({ routerModelId: 'kilo-auto/custom/mine', model: HAIKU })
    ).toMatchObject({ kind: 'ok' });

    const [call] = mockedFindCustomRouter.mock.calls;
    expect(call?.[0]).toEqual({ type: 'user', id: 'user-1' });
    expect(call?.[1]).toBe('mine');
    expect(call?.[2] === db).toBe(true);
  });

  it('refuses a pool slug the authenticated owner does not hold', async () => {
    mockedFindCustomRouter.mockResolvedValue(null);

    expect(await checkSigned({ routerModelId: 'kilo-auto/custom/theirs', model: HAIKU })).toEqual({
      kind: 'rejected',
      reason: 'pool_mismatch',
    });
    const [call] = mockedFindCustomRouter.mock.calls;
    expect(call?.[0]).toEqual({ type: 'user', id: 'user-1' });
    expect(call?.[1]).toBe('theirs');
    expect(call?.[2] === db).toBe(true);
  });
});

describe('checkAutoDecision against a saved serving pin', () => {
  beforeEach(() => {
    mockedFindCustomRouter.mockResolvedValue(pinnedPool);
  });

  it('refuses a stale alias token once its entry is pinned', async () => {
    expect(await checkSigned({ entryModel: ALIAS, model: ALIAS })).toEqual({
      kind: 'rejected',
      reason: 'pool_stale_alias',
    });
  });

  it('serves the saved pin a timely token names instead of drifting to the alias', async () => {
    expect(await checkSigned({ entryModel: ALIAS, model: SONNET })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: SONNET },
    });
  });

  it('refuses a concrete target that is neither the entry nor its pin', async () => {
    expect(await checkSigned({ entryModel: ALIAS, model: 'anthropic/claude-opus-4' })).toEqual({
      kind: 'rejected',
      reason: 'pool_mismatch',
    });
  });

  it("refuses another entry's pin as this entry's target", async () => {
    expect(await checkSigned({ entryModel: HAIKU, model: SONNET })).toEqual({
      kind: 'rejected',
      reason: 'pool_mismatch',
    });
  });

  it('serves the retirement fallback the pool saved that exact pin for', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(MOVED));

    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: MOVED,
      })
    ).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: MOVED },
    });
  });

  it('refuses a retirement fallback that names another model as the saved pin', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(MOVED));

    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: ALIAS,
        servingFallback: true,
        servingPinModel: 'openai/gpt-5',
        servingFallbackTarget: MOVED,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_stale_alias' });
  });

  it('refuses a retirement fallback on an unpinned entry', async () => {
    expect(
      await checkSigned({
        entryModel: HAIKU,
        model: HAIKU,
        servingFallback: true,
        servingPinModel: HAIKU,
        servingFallbackTarget: HAIKU,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_mismatch' });
  });

  it('refuses a retirement fallback that dispatches the saved pin itself', async () => {
    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: SONNET,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: MOVED,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_mismatch' });
  });

  it('refuses a retirement fallback the alias moved away from after signing', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets('anthropic/claude-opus-4-7'));

    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: MOVED,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_stale_alias' });
  });

  it('refuses a retirement fallback without a stored alias target', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(new Map());

    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: MOVED,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_stale_alias' });
  });

  it('refuses a retirement fallback whose stored target is the pin it retired', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(SONNET));

    expect(
      await checkSigned({
        entryModel: ALIAS,
        model: ALIAS,
        servingFallback: true,
        servingPinModel: SONNET,
        servingFallbackTarget: SONNET,
      })
    ).toEqual({ kind: 'rejected', reason: 'pool_stale_alias' });
  });

  it('refuses a legacy token for the entry once it acquires a pin', async () => {
    expect(await checkSigned({ model: ALIAS })).toEqual({
      kind: 'rejected',
      reason: 'pool_stale_alias',
    });
  });

  it('accepts a legacy token that names the saved pin exactly', async () => {
    expect(await checkSigned({ model: SONNET })).toMatchObject({ kind: 'ok' });
  });

  it('refuses a legacy token for a concrete target the pool never saved', async () => {
    expect(await checkSigned({ model: 'qwen/qwen3-coder' })).toEqual({
      kind: 'rejected',
      reason: 'pool_mismatch',
    });
  });

  it('accepts an entry model while the pool has not pinned it', async () => {
    expect(await checkSigned({ entryModel: HAIKU, model: HAIKU })).toMatchObject({ kind: 'ok' });
  });

  it('never dispatches an alias just because its entry is pinned', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(MOVED));

    expect(await checkSigned({ entryModel: ALIAS, model: ALIAS })).toEqual({
      kind: 'rejected',
      reason: 'pool_stale_alias',
    });
    const [call] = mockedFindCustomRouter.mock.calls;
    expect(call?.[0]).toEqual({ type: 'org', id: 'org-1' });
    expect(call?.[1]).toBe('team');
    expect(call?.[2] === db).toBe(false);
  });

  it('serves the saved pin when the worker dispatches it without a fallback marker', async () => {
    expect(await checkSigned({ entryModel: ALIAS, model: SONNET })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: SONNET },
    });
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

describe('checkAutoDecision against a bare alias', () => {
  it('dispatches the stored concrete target so a later move cannot remap it', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(MOVED));

    expect(await checkSigned({ entryModel: ALIAS, model: ALIAS })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: MOVED },
    });
  });

  it('reads the pool and alias targets in one read-only snapshot', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets(MOVED));

    await checkSigned({ entryModel: ALIAS, model: ALIAS });

    expect(transactionSpy).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    const transactionalReads = mockedFindCustomRouter.mock.calls.filter(
      ([, , fromDb]) => fromDb !== db
    );
    expect(transactionalReads).toHaveLength(1);
    expect(mockedReadLatestAliasTargets.mock.calls[0]?.[0]).toBe(
      mockedFindCustomRouter.mock.calls[0]?.[2]
    );
  });

  it('keeps the alias when the snapshot has no stored target', async () => {
    expect(await checkSigned({ entryModel: ALIAS, model: ALIAS })).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/org/team',
      resolved: { model: ALIAS },
    });
  });

  it('keeps the alias when the stored target is another alias', async () => {
    mockedReadLatestAliasTargets.mockResolvedValue(aliasTargets('~anthropic/claude-latest'));

    expect(await checkSigned({ entryModel: ALIAS, model: ALIAS })).toMatchObject({
      kind: 'ok',
      resolved: { model: ALIAS },
    });
  });
});

describe('signed pool identity', () => {
  it('refuses to sign a fallback marker without the entry it retires', async () => {
    await expect(
      signAutoDecision(
        {
          ...payload,
          model: ALIAS,
          variant: null,
          servingFallback: true,
          servingPinModel: SONNET,
          servingFallbackTarget: MOVED,
        },
        SECRET
      )
    ).rejects.toThrow(/entryModel/);
  });

  it('refuses to sign a fallback marker without the pin and target it proves', async () => {
    await expect(
      signAutoDecision(
        {
          ...payload,
          model: ALIAS,
          variant: null,
          entryModel: ALIAS,
          servingFallback: true,
          servingFallbackTarget: MOVED,
        },
        SECRET
      )
    ).rejects.toThrow(/servingPinModel/);
    await expect(
      signAutoDecision(
        {
          ...payload,
          model: ALIAS,
          variant: null,
          entryModel: ALIAS,
          servingFallback: true,
          servingPinModel: SONNET,
        },
        SECRET
      )
    ).rejects.toThrow(/servingFallbackTarget/);
  });

  it('refuses to sign a proof without a fallback marker', async () => {
    await expect(
      signAutoDecision({ ...payload, model: ALIAS, variant: null, servingPinModel: SONNET }, SECRET)
    ).rejects.toThrow(/servingPinModel/);
    await expect(
      signAutoDecision(
        { ...payload, model: ALIAS, variant: null, servingFallbackTarget: MOVED },
        SECRET
      )
    ).rejects.toThrow(/servingFallbackTarget/);
  });
});
