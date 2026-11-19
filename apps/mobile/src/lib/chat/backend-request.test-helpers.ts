import { type FetchLike, type ModelError } from '@kilocode/harness-sdk';
import { expect, vi } from 'vitest';

import { type BackendDiscoveryFetch } from './backend-request';
import {
  BackendRequestError,
  type BackendRequestProblem,
  type ChatBackendDraft,
} from './backend-store';

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

export const profile: ChatBackendDraft = {
  name: 'Remote',
  baseUrl: 'https://remote.example/v1',
  apiKind: 'chat_completions',
  apiKey: 'private-key',
  headers: { 'X-Custom': 'private-header' },
  models: [{ id: 'manual-model', name: 'Manual', tools: false, images: false, reasoning: false }],
  allowLocalHttp: false,
};

export const OK_STREAM =
  'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** A provider failure event the wire reads as a stream reason, plus its pieces. */
const DELTA = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n';
const CUT_EVENT = 'data: {"error":{"message":"cut","type":"server_error"}}\n\n';
const END_EVENT = 'data: [DONE]\n\n';
export const DELTA_THEN_CUT = [DELTA, CUT_EVENT, END_EVENT] as const;

export const stalledDiscovery: BackendDiscoveryFetch = async (_url, request) => {
  const { promise, reject } = Promise.withResolvers<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>();
  const abort = () => {
    const abortError = new Error('private-key');
    abortError.name = 'AbortError';
    reject(abortError);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  await promise;
  return promise;
};

/** Plain transport failure, not an abort; provider text rides along. */
export const unreachableDiscovery: BackendDiscoveryFetch = async () => {
  await Promise.resolve();
  throw new TypeError('fetch failed: private-key private-header');
};

/** One check transport builder: `failure` set fails the stream after its chunks, else the chunks play out. */
export const serving =
  ({ chunks = [''], failure }: { chunks?: readonly string[]; failure?: ModelError }): FetchLike =>
  async () => {
    await Promise.resolve('serving');
    return {
      ok: true,
      status: 200,
      text: vi.fn<() => Promise<string>>().mockResolvedValue(''),
      stream: async function* stream() {
        for (const chunk of chunks) {
          yield chunk;
        }
        if (failure !== undefined) {
          throw failure;
        }
      },
    };
  };

/** A check transport that answers nothing: only the deadline or a caller abort ends it. */
export const stalledCheck = (): FetchLike =>
  vi.fn<FetchLike>().mockImplementation(() => new Promise<never>(() => undefined));

/** One discovery transport, with the body and status a test names. */
export const discoveryAnswering =
  (body: string, status = 200): BackendDiscoveryFetch =>
  async () => {
    const text = await Promise.resolve(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: vi.fn<() => Promise<string>>().mockResolvedValue(text),
    };
  };

/** Asserts the problem class and that no provider text escapes the error. */
export async function expectProblem(
  work: Promise<unknown>,
  problem: BackendRequestProblem
): Promise<void> {
  const failure: unknown = await work.then(
    () => null,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(BackendRequestError);
  expect((failure as BackendRequestError).problem).toBe(problem);
  // Provider text can echo authorization headers or API keys, so nothing but
  // the problem name may speak.
  expect((failure as Error).message).not.toMatch(/private-key|private-header/u);
  expect(String(failure)).not.toMatch(/private-key|private-header/u);
}
