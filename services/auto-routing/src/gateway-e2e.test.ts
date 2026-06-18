import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { clearClassifierConfigCache } from './classifier-config';
import { clearRoutingTableCache } from './routing-table';

vi.mock('@/lib/config.server', () => ({
  AUTO_ROUTING_WORKER_URL: '',
  INTERNAL_API_SECRET: '',
}));

vi.mock('@/lib/utils.server', () => ({
  warnExceptInTest: vi.fn(),
}));

const originalFetch = globalThis.fetch;

const classification = {
  taskType: 'implementation',
  subtaskType: 'feature_development',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'low',
  executionMode: 'code_change',
  requiresTools: true,
  confidence: 0.9,
};

const routingTable = {
  version: 'local-e2e',
  generatedAt: '1970-01-01T00:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  source: 'benchmark',
  routes: {
    'implementation/feature_development': [
      {
        model: 'openai/gpt-4o',
        accuracy: 0.92,
        avgCostUsd: 0.001,
        meetsThreshold: true,
        reasoningEffort: null,
      },
      {
        model: 'anthropic/claude-haiku-4',
        accuracy: 0.88,
        avgCostUsd: 0.002,
        meetsThreshold: true,
        reasoningEffort: null,
      },
    ],
  },
};

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'classifier-token' },
  AUTO_ROUTING_CONFIG: {
    get: async (key: string) => (key === 'routing_table_v1' ? JSON.stringify(routingTable) : null),
    put: async () => undefined,
    delete: async () => undefined,
  },
  BENCHMARK_SERVICE: {
    fetch: async (url: string) => {
      if (String(url).includes('/admin/classifier-winner')) {
        return new Response(JSON.stringify({ winner: null }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ table: routingTable, publishedAt: routingTable.generatedAt }),
        { status: 200 }
      );
    },
  },
  AUTO_ROUTING_CLASSIFIER_METRICS_V2: { writeDataPoint: () => undefined },
  AUTO_ROUTING_DECISION_CACHE: {
    idFromName: () => 'local-e2e-cache',
    get: () => ({
      getEntry: async (key: string) => (key === 'sticky' ? null : classification),
      putEntry: async () => undefined,
    }),
  },
  O11Y_CF_ACCOUNT_ID: 'local',
  O11Y_CF_AE_API_TOKEN: { get: async () => 'token' },
} as unknown as Env;

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe('gateway to auto-routing worker local e2e', () => {
  beforeEach(() => {
    clearClassifierConfigCache();
    clearRoutingTableCache();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://auto-routing.local/decide') {
        return app.request(url, init, env, executionCtx);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes around organization-denied models', async () => {
    const { fetchEfficientAutoDecision } =
      await import('../../../apps/web/src/lib/ai-gateway/auto-routing-decision');

    const result = await fetchEfficientAutoDecision(
      {
        apiKind: 'chat_completions',
        body: {
          model: 'kilo-auto/efficient',
          stream: true,
          messages: [
            { role: 'system', content: 'You are Kilo Code.' },
            { role: 'user', content: 'Fix the parser bug.' },
          ],
        },
        requestedModel: 'kilo-auto/efficient',
        providerHints: { provider: null, providerOptions: null },
        bodyBytes: 512,
        userId: 'user-1',
        sessionId: 'task-123',
        machineId: 'machine-1',
        clientRequestId: 'req-1',
        mode: 'code',
        userAgent: 'local-e2e',
        deniedModelIds: ['openai/gpt-4o'],
      },
      {
        workerUrl: 'https://auto-routing.local',
        authToken: 'classifier-token',
        timeoutMs: 5000,
      }
    );

    expect(result?.decision?.model).toBe('anthropic/claude-haiku-4');
  });
});
