import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendHeaders, discoverBackendModels } from './backend-request';
import { BackendInputError, BackendRequestError } from './backend-store';
import {
  discoveryAnswering,
  expectProblem,
  profile,
  stalledDiscovery,
  unreachableDiscovery,
} from './backend-request.test-helpers';

vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn().mockResolvedValue(null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

afterEach(() => vi.useRealTimers());

describe('remote backend requests', () => {
  it('uses only configured credentials and case-insensitive header overrides', () => {
    expect(backendHeaders(profile)).toEqual({
      authorization: 'Bearer private-key',
      'x-custom': 'private-header',
    });
    expect(backendHeaders({ ...profile, headers: { AUTHORIZATION: 'custom-auth' } })).toEqual({
      authorization: 'custom-auth',
    });
    expect(backendHeaders({ ...profile, apiKind: 'messages' })).toEqual({
      'x-api-key': 'private-key',
      'anthropic-version': '2023-06-01',
      'x-custom': 'private-header',
    });
    expect(backendHeaders({ ...profile, apiKey: '', headers: {} })).toEqual({});
  });

  it('discovers unique models without implicit tools or manual-list mutation', async () => {
    const transport = discoveryAnswering(
      JSON.stringify({ data: [{ id: 'found' }, { id: 'found' }, { id: 'other', name: 'Other' }] })
    );
    const found = await discoverBackendModels(profile, new AbortController().signal, transport);
    expect(found).toEqual([
      { id: 'found', name: 'found', tools: false, images: false, reasoning: false },
      { id: 'other', name: 'Other', tools: false, images: false, reasoning: false },
    ]);
    expect(profile.models[0]?.id).toBe('manual-model');
  });

  it('reports a caller abort as cancelled, not from the deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectProblem(
      discoverBackendModels(profile, controller.signal, stalledDiscovery),
      'cancelled'
    );
  });

  it('reports a deadline whose transport rejected with AbortError as timedOut', async () => {
    vi.useFakeTimers();
    const work = discoverBackendModels(profile, new AbortController().signal, stalledDiscovery);
    const outcome = expectProblem(work, 'timedOut');
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'notFound'],
    [429, 'rateLimited'],
    [503, 'unavailable'],
    [400, 'invalidResponse'],
  ] as const)('renders a %i discovery refusal as %s', async (status, problem) => {
    // The refused body carries credentials; a wrong-model refusal does not.
    const body = status === 400 ? 'private-header' : 'no models here';
    await expectProblem(
      discoverBackendModels(
        profile,
        new AbortController().signal,
        discoveryAnswering(body, status)
      ),
      problem
    );
  });

  it.each([
    ['private-header', 400, 'invalidResponse'],
    [{ data: [{ id: '' }] }, 400, 'invalidResponse'],
    [{ data: [] }, 200, 'noModels'],
  ] as const)('renders discovery body %s with status %i as %s', async (body, status, problem) => {
    await expectProblem(
      discoverBackendModels(
        profile,
        new AbortController().signal,
        discoveryAnswering(JSON.stringify(body), status)
      ),
      problem
    );
  });

  it('preserves manual models when discovery is unsupported', async () => {
    await expectProblem(
      discoverBackendModels(
        profile,
        new AbortController().signal,
        discoveryAnswering('private-key', 404)
      ),
      'notFound'
    );
    expect(profile.models[0]?.id).toBe('manual-model');
  });

  it('renders a network rejection as unreachable', async () => {
    await expectProblem(
      discoverBackendModels(profile, new AbortController().signal, unreachableDiscovery),
      'unreachable'
    );
  });

  it('leaves draft validation failures on the input contract', async () => {
    // A model list is required input; without one the connection is invalid.
    const invalid: unknown = {
      baseUrl: 'https://remote.example/v1',
      apiKind: 'chat_completions',
      models: [],
    };
    const failure: unknown = await discoverBackendModels(
      invalid as Parameters<typeof discoverBackendModels>[0],
      new AbortController().signal
    ).then(
      () => null,
      (error: unknown) => error
    );
    // The form reads the input contract, so the request class must not shadow it.
    expect(failure).toBeInstanceOf(BackendInputError);
    expect(failure).not.toBeInstanceOf(BackendRequestError);
  });
});
