import { beforeEach, describe, expect, it } from '@jest/globals';
import type { AutoRoutingDecision, CustomRouterDefinition } from '@kilocode/auto-routing-contracts';
import type { CustomRouterDecisionOutcome } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-decision';
import { findCustomRouter } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { readLatestAliasTargets } from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { decideCustomRouter } from './custom-router';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets', () => ({
  readLatestAliasTargets: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: { name: 'primary', transaction: jest.fn() },
  readDb: { name: 'replica' },
}));

const mockedFindCustomRouter = jest.mocked(findCustomRouter);
const mockedReadLatestAliasTargets = jest.mocked(readLatestAliasTargets);
const mockedTransaction = jest.mocked(db.transaction);

const router: CustomRouterDefinition = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerType: 'user',
  ownerId: 'user-1',
  slug: 'mine',
  name: 'Mine',
  baseRouter: 'efficient',
  mode: 'cost_per_accuracy',
  entries: [
    { kind: 'gateway', model: 'anthropic/claude-haiku-4.5' },
    { kind: 'gateway', model: 'openai/gpt-5-mini' },
    {
      kind: 'client',
      provider: 'ollama',
      model: 'qwen3:32b',
      variants: [],
      capabilities: {
        contextLength: 32_000,
        inputModalities: ['text'],
        toolCall: true,
        reasoning: false,
      },
      pricing: null,
    },
  ],
  defaultEntryKey: 'gateway:openai/gpt-5-mini',
};

function gatewayDecision(model: string): AutoRoutingDecision {
  return {
    model,
    entry: { kind: 'gateway', model },
    taskType: 'implementation',
    subtaskType: 'feature_development',
    source: 'benchmark',
    tableVersion: 'v1',
    sticky: false,
    stale: false,
    fallback: false,
  };
}

const deniedModelIds = jest.fn(async (_candidates: ReadonlyArray<string>) => [] as string[]);
const decide = jest.fn(
  async (
    _router: CustomRouterDefinition,
    _denied: ReadonlyArray<string>
  ): Promise<CustomRouterDecisionOutcome> => ({
    kind: 'ok',
    decision: gatewayDecision('anthropic/claude-haiku-4.5'),
    costUsd: 0,
  })
);

function decideFor(
  reference: { scope: 'user' | 'org'; slug: string },
  organizationId: string | null = null
) {
  return decideCustomRouter({
    reference,
    userId: 'user-1',
    organizationId,
    deniedModelIds,
    decide,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFindCustomRouter.mockResolvedValue(router);
  mockedReadLatestAliasTargets.mockResolvedValue(new Map());
  mockedTransaction.mockImplementation(
    (async (callback: (tx: unknown) => Promise<unknown>) =>
      await callback({})) as typeof db.transaction
  );
});

describe('decideCustomRouter', () => {
  it('resolves a personal router for the authenticated user, even in an organization context', async () => {
    const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

    const [lookup] = mockedFindCustomRouter.mock.calls;
    expect(lookup?.slice(0, 2)).toEqual([{ type: 'user', id: 'user-1' }, 'mine']);
    expect(lookup?.[2] === db).toBe(true);
    expect(result).toEqual({ kind: 'ok', decision: gatewayDecision('anthropic/claude-haiku-4.5') });
  });

  it('resolves an organization router in the active organization context', async () => {
    await decideFor({ scope: 'org', slug: 'team' }, 'org-1');

    const [lookup] = mockedFindCustomRouter.mock.calls;
    expect(lookup?.slice(0, 2)).toEqual([{ type: 'org', id: 'org-1' }, 'team']);
    expect(lookup?.[2] === db).toBe(true);
  });

  it('answers router_not_found for an organization router without an organization context', async () => {
    const result = await decideFor({ scope: 'org', slug: 'team' }, null);

    expect(result).toEqual({
      kind: 'rejected',
      code: 'router_not_found',
      message: 'Custom router not found',
    });
    expect(mockedFindCustomRouter).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('answers router_not_found for a missing router', async () => {
    mockedFindCustomRouter.mockResolvedValue(null);

    const result = await decideFor({ scope: 'user', slug: 'missing' });

    expect(result).toMatchObject({ kind: 'rejected', code: 'router_not_found' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('evaluates the organization policy over the gateway entries only', async () => {
    deniedModelIds.mockResolvedValueOnce(['openai/gpt-5-mini']);

    await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

    expect(deniedModelIds).toHaveBeenCalledWith([
      'anthropic/claude-haiku-4.5',
      'openai/gpt-5-mini',
    ]);
    expect(decide).toHaveBeenCalledWith(router, ['openai/gpt-5-mini']);
  });

  it.each([
    ['a null decision', null],
    ['a model outside the pool', gatewayDecision('qwen/qwen3-coder')],
    [
      'a decision without a pool entry',
      { ...gatewayDecision('openai/gpt-5-mini'), entry: undefined },
    ],
    [
      'a client entry',
      {
        ...gatewayDecision('client:ollama/qwen3:32b'),
        entry: { kind: 'client', provider: 'ollama', model: 'qwen3:32b' },
      },
    ],
  ] satisfies Array<[string, AutoRoutingDecision | null]>)(
    'never serves %s',
    async (_name, decision) => {
      decide.mockResolvedValueOnce({ kind: 'ok', decision, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' })).toEqual({ kind: 'unavailable' });
    }
  );

  it('never serves a model the policy denies', async () => {
    deniedModelIds.mockResolvedValueOnce(['anthropic/claude-haiku-4.5']);

    expect(await decideFor({ scope: 'user', slug: 'mine' })).toEqual({ kind: 'unavailable' });
  });

  it('passes worker rejections and outages through', async () => {
    decide.mockResolvedValueOnce({
      kind: 'rejected',
      code: 'custom_router_unavailable',
      message: 'No entry of this custom router is available to this client',
    });
    expect(await decideFor({ scope: 'user', slug: 'mine' })).toEqual({
      kind: 'rejected',
      code: 'custom_router_unavailable',
      message: 'No entry of this custom router is available to this client',
    });

    decide.mockResolvedValueOnce({ kind: 'unavailable' });
    expect(await decideFor({ scope: 'user', slug: 'mine' })).toEqual({ kind: 'unavailable' });
  });

  describe('serving pins', () => {
    const ALIAS = '~anthropic/latest';
    const PINNED = 'anthropic/claude-sonnet-4.6';
    const STORED = 'anthropic/claude-sonnet-4.5';
    const pin = {
      model: PINNED,
      pinnedAt: '2026-11-20T00:00:00.000Z',
      requestId: '33333333-3333-4333-8333-333333333333',
      confirmedAt: '2026-11-20T00:00:00.000Z',
    };
    const pinnedRouter: CustomRouterDefinition = {
      ...router,
      entries: [{ kind: 'gateway', model: ALIAS, servingPin: pin }],
      defaultEntryKey: `gateway:${ALIAS}`,
    };
    const pinnedDecision = (model: string): AutoRoutingDecision => ({
      ...gatewayDecision(ALIAS),
      model,
      entry: { kind: 'gateway', model: ALIAS },
      ...(model === PINNED ? { servingPin: pin } : {}),
    });
    const storedTarget = (target = STORED) => new Map([[ALIAS, { alias: ALIAS, target }]]);

    beforeEach(() => {
      mockedFindCustomRouter.mockResolvedValue(pinnedRouter);
    });

    it('accepts the saved pin and evaluates the policy over the pin too', async () => {
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
        costUsd: 0,
      });

      const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, PINNED]);
      expect(result).toEqual({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
      });
    });

    it('reads the pool and alias targets in one read-only snapshot', async () => {
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
        costUsd: 0,
      });

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(mockedTransaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      const txReads = mockedFindCustomRouter.mock.calls.filter(([, , fromDb]) => fromDb !== db);
      expect(txReads).toHaveLength(1);
      expect(decide.mock.calls.at(-1)?.[0]).toBe(pinnedRouter);
      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, PINNED]);
    });

    it('keeps a single primary read for a pool without an alias', async () => {
      mockedFindCustomRouter.mockResolvedValue(router);

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(mockedTransaction).not.toHaveBeenCalled();
      expect(mockedFindCustomRouter).toHaveBeenCalledTimes(1);
    });

    it('serves the pool and alias target from the same snapshot', async () => {
      // The first primary read predates the promotion: no pin, and only the pre-move target.
      mockedFindCustomRouter.mockImplementation(async (_owner, _slug, fromDb) =>
        fromDb === db
          ? { ...pinnedRouter, entries: [{ kind: 'gateway', model: ALIAS }] }
          : pinnedRouter
      );
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
        costUsd: 0,
      });

      const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, STORED, PINNED]);
      expect(decide.mock.calls.at(-1)?.[0]).toBe(pinnedRouter);
      expect(result).toEqual({ kind: 'ok', decision: pinnedDecision(PINNED) });
    });

    it('names the snapshot alias target in the deny policy', async () => {
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, STORED, PINNED]);
    });

    it('refuses a dispatch that is neither the pool entry nor its saved pin', async () => {
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision('anthropic/claude-haiku-4.5'),
        costUsd: 0,
      });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('refuses a bare alias under a saved pin without the retirement marker', async () => {
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(ALIAS),
        costUsd: 0,
      });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('serves the marked retirement fallback as its snapshot concrete target', async () => {
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      const retirement: AutoRoutingDecision & { servingFallback: true } = {
        ...pinnedDecision(ALIAS),
        servingFallback: true,
      };
      decide.mockResolvedValueOnce({ kind: 'ok', decision: retirement, costUsd: 0 });

      const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(result).toEqual({
        kind: 'ok',
        decision: {
          ...retirement,
          model: STORED,
          entry: { kind: 'gateway', model: STORED },
        },
      });
    });

    it('refuses a retirement marker whose snapshot target is the retired pin', async () => {
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget(PINNED));
      const retirement: AutoRoutingDecision & { servingFallback: true } = {
        ...pinnedDecision(ALIAS),
        servingFallback: true,
      };
      decide.mockResolvedValueOnce({ kind: 'ok', decision: retirement, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('refuses a marked retirement fallback with no snapshot target', async () => {
      const retirement: AutoRoutingDecision & { servingFallback: true } = {
        ...pinnedDecision(ALIAS),
        servingFallback: true,
      };
      decide.mockResolvedValueOnce({ kind: 'ok', decision: retirement, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('refuses a marked retirement fallback the policy denies', async () => {
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      deniedModelIds.mockResolvedValueOnce([STORED]);
      const retirement: AutoRoutingDecision & { servingFallback: true } = {
        ...pinnedDecision(ALIAS),
        servingFallback: true,
      };
      decide.mockResolvedValueOnce({ kind: 'ok', decision: retirement, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('dispatches the snapshot concrete target for an accepted bare alias', async () => {
      mockedFindCustomRouter.mockResolvedValue({
        ...router,
        entries: [{ kind: 'gateway', model: ALIAS }],
        defaultEntryKey: `gateway:${ALIAS}`,
      });
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      const aliasDecision = gatewayDecision(ALIAS);
      decide.mockResolvedValueOnce({ kind: 'ok', decision: aliasDecision, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'ok',
        decision: {
          ...aliasDecision,
          model: STORED,
          entry: { kind: 'gateway', model: STORED },
        },
      });
    });

    it('refuses an alias whose snapshot target the policy denies', async () => {
      mockedFindCustomRouter.mockResolvedValue({
        ...router,
        entries: [{ kind: 'gateway', model: ALIAS }],
        defaultEntryKey: `gateway:${ALIAS}`,
      });
      mockedReadLatestAliasTargets.mockResolvedValue(storedTarget());
      deniedModelIds.mockResolvedValueOnce([STORED]);
      const aliasDecision = gatewayDecision(ALIAS);
      decide.mockResolvedValueOnce({ kind: 'ok', decision: aliasDecision, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('keeps an alias id when the snapshot stores no concrete target', async () => {
      mockedFindCustomRouter.mockResolvedValue({
        ...router,
        entries: [{ kind: 'gateway', model: ALIAS }],
        defaultEntryKey: `gateway:${ALIAS}`,
      });
      const aliasDecision = gatewayDecision(ALIAS);
      decide.mockResolvedValueOnce({ kind: 'ok', decision: aliasDecision, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'ok',
        decision: aliasDecision,
      });
    });

    it('refuses a pin the organization policy denies', async () => {
      deniedModelIds.mockResolvedValueOnce([PINNED]);
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
        costUsd: 0,
      });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });
  });
});
