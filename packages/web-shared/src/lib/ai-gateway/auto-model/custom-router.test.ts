import { beforeEach, describe, expect, it } from '@jest/globals';
import type { AutoRoutingDecision, CustomRouterDefinition } from '@kilocode/auto-routing-contracts';
import type { CustomRouterDecisionOutcome } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-decision';
import { findDecisionPool } from '@kilocode/web-shared/lib/ai-gateway/auto-model/decision-pool';
import { decideCustomRouter } from './custom-router';

// `findDecisionPool` is the one primary statement that reads the pool and its alias targets, so it
// is replaced here: a test asserts what the decision layer does with one coherent read rather than
// replaying a query builder. The read's own filtering (`poolAliasTargets`) is covered in the
// contracts suite, where that rule lives.
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/decision-pool', () => ({
  findDecisionPool: jest.fn(),
}));

const mockedFindDecisionPool = jest.mocked(findDecisionPool);

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
    _denied: ReadonlyArray<string>,
    _aliasTargets: ReadonlyMap<string, string>
  ): Promise<CustomRouterDecisionOutcome> => ({
    kind: 'ok',
    decision: gatewayDecision('anthropic/claude-haiku-4.5'),
    costUsd: 0,
  })
);

// The saved pool and the alias targets one statement returns. The decision layer must treat the
// two as one generation, so every fixture carries them together.
function pool(
  definition: CustomRouterDefinition | null,
  aliasTargets: ReadonlyArray<[string, string]> = []
) {
  return definition === null ? null : { router: definition, aliasTargets: new Map(aliasTargets) };
}

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
  mockedFindDecisionPool.mockResolvedValue(pool(router));
});

describe('decideCustomRouter', () => {
  it('uses the owned pool in the organization context', async () => {
    const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

    // The whole read happens in the one seam, so the decision layer never opens its own read or
    // transaction. (The seam's own single statement is the subject of `findDecisionPool`.)
    expect(mockedFindDecisionPool).toHaveBeenCalledTimes(1);
    expect(mockedFindDecisionPool).toHaveBeenCalledWith({ type: 'user', id: 'user-1' }, 'mine');
    expect(result).toEqual({ kind: 'ok', decision: gatewayDecision('anthropic/claude-haiku-4.5') });
  });

  it('resolves a personal router for the authenticated user, even in an organization context', async () => {
    await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

    // A personal reference scopes the pool lookup to the user's own owner, never the org's.
    expect(mockedFindDecisionPool).toHaveBeenCalledWith({ type: 'user', id: 'user-1' }, 'mine');
  });

  it('resolves an organization router in the active organization context', async () => {
    mockedFindDecisionPool.mockResolvedValue(
      pool({ ...router, ownerType: 'org', ownerId: 'org-1', slug: 'team' })
    );

    await decideFor({ scope: 'org', slug: 'team' }, 'org-1');

    expect(mockedFindDecisionPool).toHaveBeenCalledWith({ type: 'org', id: 'org-1' }, 'team');
  });

  it('answers router_not_found for an organization router without an organization context', async () => {
    const result = await decideFor({ scope: 'org', slug: 'team' }, null);

    expect(result).toEqual({
      kind: 'rejected',
      code: 'router_not_found',
      message: 'Custom router not found',
    });
    expect(mockedFindDecisionPool).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('answers router_not_found for a missing router', async () => {
    mockedFindDecisionPool.mockResolvedValue(null);

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
    expect(decide).toHaveBeenCalledWith(router, ['openai/gpt-5-mini'], new Map());
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
    const storedTarget = (target = STORED): Array<[string, string]> => [[ALIAS, target]];

    beforeEach(() => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter));
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

    it('checks the stored target and pin returned with the owned pool', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(PINNED),
        costUsd: 0,
      });

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      // One call returns the definition and the stored target together, so a promotion cannot land
      // between them. (That the seam is one statement is asserted in `findDecisionPool`.)
      expect(mockedFindDecisionPool).toHaveBeenCalledTimes(1);
      expect(decide.mock.calls.at(-1)?.[0]).toBe(pinnedRouter);
      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, STORED, PINNED]);
    });

    it('keeps one seam call for a pool without an alias', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(router));

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(mockedFindDecisionPool).toHaveBeenCalledTimes(1);
    });

    it('dispatches an unpinned alias to the target returned with its pool', async () => {
      // The statement returns the pre-promotion definition (no pin yet) together with the target the
      // alias already serves, so the pool the policy is derived from and the target the worker ranks
      // are one generation. A bare alias decision is accepted and dispatched as that target.
      mockedFindDecisionPool.mockResolvedValue(
        pool({ ...pinnedRouter, entries: [{ kind: 'gateway', model: ALIAS }] }, storedTarget())
      );
      decide.mockResolvedValueOnce({ kind: 'ok', decision: gatewayDecision(ALIAS), costUsd: 0 });

      const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      // No pin in this snapshot, so only the entry and its stored target are candidates.
      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, STORED]);
      expect(decide.mock.calls.at(-1)?.[0]).toEqual({
        ...pinnedRouter,
        entries: [{ kind: 'gateway', model: ALIAS }],
      });
      expect(result).toEqual({
        kind: 'ok',
        decision: {
          ...gatewayDecision(ALIAS),
          model: STORED,
          entry: { kind: 'gateway', model: STORED },
        },
      });
    });

    it('hands the worker the same alias target the policy was derived from', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      // Same map, so a denied live target can be routed around in the worker rather than ranked
      // and refused here after the pick.
      expect(decide.mock.calls.at(-1)?.[2]).toEqual(new Map([[ALIAS, STORED]]));
    });

    it('names the statement alias target in the deny policy', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(deniedModelIds).toHaveBeenCalledWith([ALIAS, STORED, PINNED]);
    });

    it('hands the worker only this pool alias targets', async () => {
      // A stored target that is another alias, a virtual model, or an alias this pool does not own
      // is not a dispatchable target. `findDecisionPool` drops those before the decision layer
      // sees them, so the seam here carries only the pool's own concrete target.
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));

      await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

      expect(decide.mock.calls.at(-1)?.[2]).toEqual(new Map([[ALIAS, STORED]]));
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
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));
      decide.mockResolvedValueOnce({
        kind: 'ok',
        decision: pinnedDecision(ALIAS),
        costUsd: 0,
      });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('serves the marked retirement fallback as its statement concrete target', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));
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

    it('refuses a retirement marker whose statement target is the retired pin', async () => {
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget(PINNED)));
      const retirement: AutoRoutingDecision & { servingFallback: true } = {
        ...pinnedDecision(ALIAS),
        servingFallback: true,
      };
      decide.mockResolvedValueOnce({ kind: 'ok', decision: retirement, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('refuses a marked retirement fallback with no statement target', async () => {
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
      mockedFindDecisionPool.mockResolvedValue(pool(pinnedRouter, storedTarget()));
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

    it('dispatches the statement concrete target for an accepted bare alias', async () => {
      mockedFindDecisionPool.mockResolvedValue(
        pool(
          {
            ...router,
            entries: [{ kind: 'gateway', model: ALIAS }],
            defaultEntryKey: `gateway:${ALIAS}`,
          },
          storedTarget()
        )
      );
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

    it('refuses an alias whose statement target the policy denies', async () => {
      mockedFindDecisionPool.mockResolvedValue(
        pool(
          {
            ...router,
            entries: [{ kind: 'gateway', model: ALIAS }],
            defaultEntryKey: `gateway:${ALIAS}`,
          },
          storedTarget()
        )
      );
      deniedModelIds.mockResolvedValueOnce([STORED]);
      const aliasDecision = gatewayDecision(ALIAS);
      decide.mockResolvedValueOnce({ kind: 'ok', decision: aliasDecision, costUsd: 0 });

      expect(await decideFor({ scope: 'user', slug: 'mine' }, 'org-1')).toEqual({
        kind: 'unavailable',
      });
    });

    it('keeps an alias id when the statement stores no concrete target', async () => {
      mockedFindDecisionPool.mockResolvedValue(
        pool({
          ...router,
          entries: [{ kind: 'gateway', model: ALIAS }],
          defaultEntryKey: `gateway:${ALIAS}`,
        })
      );
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
