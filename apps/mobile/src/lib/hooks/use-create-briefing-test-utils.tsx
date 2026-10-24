import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

import { handleTrpcQueryError } from '@/lib/auth/trpc-unauthorized';
import { act, TestRenderer } from '@/test/renderer';
import {
  type CreateBriefingState,
  type PreparedBriefing,
  useCreateBriefing,
} from './use-create-briefing';

export const input = {
  startAt: '2026-10-19T12:00:00.000Z',
  endAt: '2026-10-20T12:00:00.000Z',
  timezone: 'Europe/Belgrade',
  language: 'en',
};
export const prepared: PreparedBriefing = {
  report: {
    id: 'report-1',
    kind: 'one_off',
    createdAt: input.endAt,
    timezone: input.timezone,
    context: { id: 'personal', organizationId: null, name: 'Personal' },
    localDate: '2026-10-20',
    nightStartAt: input.startAt,
    cutoffAt: input.endAt,
    morningEndAt: '2026-11-19T12:00:00.000Z',
    publishedAt: null,
    updatedAt: input.endAt,
    revision: 1,
    revised: false,
    readAt: null,
    dismissedAt: null,
    scorecard: { sessions: 1, pullRequests: 0, blockers: 0, spendMicrodollars: 0 },
    coverage: {
      activity: 'partial',
      spend: 'unavailable',
      blockers: 'partial',
      pullRequests: 'partial',
    },
    sessions: [],
    sources: [],
    summary: {
      status: 'disabled',
      text: null,
      model: null,
      costMicrodollars: 0,
      chargeStatus: 'settled',
      estimatedCostMicrodollars: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      canRetry: false,
    },
    expiresAt: '2026-11-19T12:00:00.000Z',
  },
  estimate: {
    canGenerate: true,
    estimateToken: 'bound-token',
    model: 'test/model',
    estimatedCostMicrodollars: 1,
    maximumCostMicrodollars: 2,
    maxDurationSeconds: 60,
    unavailableReason: null,
  },
};
const published: { current?: CreateBriefingState } = {};
function Harness() {
  published.current = useCreateBriefing();
  return null;
}
export function state() {
  if (!published.current) {
    throw new Error('Hook is not mounted');
  }
  return published.current;
}
export function mount() {
  published.current = undefined;
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: error => {
        void handleTrpcQueryError(error);
      },
    }),
  });
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(Harness))
    );
  });
  if (!holder.renderer) {
    throw new Error('Renderer is not mounted');
  }
  return { renderer: holder.renderer, client };
}
