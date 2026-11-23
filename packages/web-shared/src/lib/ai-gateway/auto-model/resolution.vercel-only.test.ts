import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  signAutoDecision,
  type AutoRoutingDecision,
  type CustomRouterDefinition,
} from '@kilocode/auto-routing-contracts';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as MapModelIdToVercelModule from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import type * as CustomRouters from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { checkAutoDecision } from './auto-decision';
import { resolveAutoModel } from './resolution';

const VERCEL_ONLY_MODEL = 'interfaze/interfaze-beta';

const pool: CustomRouterDefinition = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerType: 'user',
  ownerId: 'user-1',
  slug: 'mine',
  name: 'Mine',
  baseRouter: 'frontier',
  mode: 'best_accuracy',
  entries: [{ kind: 'gateway', model: VERCEL_ONLY_MODEL }],
  defaultEntryKey: `gateway:${VERCEL_ONLY_MODEL}`,
};

const openRouterModels: GatewayModelMap = {
  'anthropic/claude-haiku-4.5': {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    endpoints: [],
  },
};

const vercelModels: GatewayModelMap = {
  [VERCEL_ONLY_MODEL]: {
    id: VERCEL_ONLY_MODEL,
    name: 'Interfaze Beta',
    type: 'language',
    context_window: 128_000,
    modalities: { input: ['text'], output: ['text'] },
    pricing: { input: '0.000001', output: '0.000002' },
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    endpoints: [{ provider_name: 'interfaze' }],
  },
};

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(async () => openRouterModels),
  getVercelModelsMetadataFromDatabase: jest.fn(async () => vercelModels),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  ...jest.requireActual<typeof MapModelIdToVercelModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel'
  ),
  getVercelModelIdOverrides: jest.fn(async () => new Map()),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
}));

const SECRET = 'test-decision-secret';
const NOW = 1_800_000_000_000;

type FindCustomRouter = typeof CustomRouters.findCustomRouter;
const { findCustomRouter: mockedFindCustomRouter } = jest.requireMock<{
  findCustomRouter: jest.MockedFunction<FindCustomRouter>;
}>('@kilocode/web-shared/lib/ai-gateway/custom-routers');

async function checkSignedVariant(variant: string) {
  const token = await signAutoDecision(
    {
      userId: 'user-1',
      organizationId: null,
      routerModelId: 'kilo-auto/custom/mine',
      model: VERCEL_ONLY_MODEL,
      variant,
      entryModel: VERCEL_ONLY_MODEL,
      expiresAt: NOW + 60_000,
    },
    SECRET
  );
  return checkAutoDecision({
    token,
    secret: SECRET,
    nowMs: NOW,
    userId: 'user-1',
    organizationId: null,
    model: VERCEL_ONLY_MODEL,
  });
}

function resolveCustomRouterVariant(variant: string) {
  const decision: AutoRoutingDecision = {
    model: VERCEL_ONLY_MODEL,
    variant,
    taskType: 'implementation',
    subtaskType: 'feature_development',
    source: 'benchmark',
    tableVersion: 'v1',
    sticky: false,
  };
  return resolveAutoModel(
    {
      model: 'kilo-auto/custom/org/team',
      modeHeader: null,
      sessionId: null,
      apiKind: 'chat_completions',
      clientIp: null,
      isAutoFreeCandidateAllowed: null,
      customRouterDecision: async () => ({ kind: 'ok', decision }),
    },
    Promise.resolve(null),
    Promise.resolve(0)
  );
}

describe('variants of models only Vercel serves', () => {
  beforeEach(() => {
    mockedFindCustomRouter.mockResolvedValue(pool);
  });

  it('serves a signed Auto decision for a variant Vercel lists', async () => {
    expect(await checkSignedVariant('medium')).toEqual({
      kind: 'ok',
      routerModelId: 'kilo-auto/custom/mine',
      resolved: { model: VERCEL_ONLY_MODEL, reasoning: { enabled: true, effort: 'medium' } },
    });
  });

  it('rejects a signed Auto decision for a variant Vercel does not list', async () => {
    expect(await checkSignedVariant('max')).toEqual({
      kind: 'rejected',
      reason: 'variant_unavailable',
    });
  });

  it('serves a custom router decision for a variant Vercel lists', async () => {
    expect(await resolveCustomRouterVariant('high')).toEqual({
      kind: 'ok',
      resolved: { model: VERCEL_ONLY_MODEL, reasoning: { enabled: true, effort: 'high' } },
    });
  });

  it('rejects a custom router decision for a variant Vercel does not list', async () => {
    expect(await resolveCustomRouterVariant('max')).toMatchObject({
      kind: 'custom_router_error',
      code: 'custom_router_unavailable',
    });
  });
});
