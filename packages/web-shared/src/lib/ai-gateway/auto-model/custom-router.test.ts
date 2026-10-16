import { beforeEach, describe, expect, it } from '@jest/globals';
import type { AutoRoutingDecision, CustomRouterDefinition } from '@kilocode/auto-routing-contracts';
import type { CustomRouterDecisionOutcome } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-decision';
import {
  findCustomRouter,
  isCustomRoutersEnabled,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { decideCustomRouter } from './custom-router';

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
  isCustomRoutersEnabled: jest.fn(),
}));

const mockedFindCustomRouter = jest.mocked(findCustomRouter);
const mockedIsCustomRoutersEnabled = jest.mocked(isCustomRoutersEnabled);

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
  mockedIsCustomRoutersEnabled.mockResolvedValue(true);
});

describe('decideCustomRouter', () => {
  it('resolves a personal router for the authenticated user, even in an organization context', async () => {
    const result = await decideFor({ scope: 'user', slug: 'mine' }, 'org-1');

    expect(mockedFindCustomRouter).toHaveBeenCalledWith({ type: 'user', id: 'user-1' }, 'mine');
    expect(mockedIsCustomRoutersEnabled).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ kind: 'ok', decision: gatewayDecision('anthropic/claude-haiku-4.5') });
  });

  it('resolves an organization router in the active organization context', async () => {
    await decideFor({ scope: 'org', slug: 'team' }, 'org-1');

    expect(mockedFindCustomRouter).toHaveBeenCalledWith({ type: 'org', id: 'org-1' }, 'team');
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

  it('answers router_not_found when the custom routers flag is off for the user', async () => {
    mockedIsCustomRoutersEnabled.mockResolvedValue(false);

    const result = await decideFor({ scope: 'user', slug: 'mine' });

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
});
