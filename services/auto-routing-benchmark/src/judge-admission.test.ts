import { INFERENCE_RESERVATION_STATE_HEADER } from '@kilocode/usage-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitJudgeInference } from './judge-admission';

const fetchMock = vi.fn<typeof fetch>();
const env = {
  KILO_WEB_API_BASE_URL: 'https://web.example.test',
  INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' },
} as unknown as Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_WEB_API_BASE_URL'>;
const billing = { userId: 'user-1', organizationId: '22222222-2222-4222-8222-222222222222' };
const request = { model: 'typesafe/jev-1.13', body: { model: 'typesafe/jev-1.13' } };

type Command = { action: string; requestId: string };

function command(init: RequestInit | undefined): Command {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as Command;
}

function commands() {
  return fetchMock.mock.calls.map(([, init]) => command(init));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('judge prepaid admission', () => {
  it('admits without a hold when web requires none', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ kind: 'admitted', body: request.body }));
    expect(await admitJudgeInference(env, billing, request)).toBe('admitted');
    expect(commands()).toEqual([
      expect.objectContaining({
        action: 'admit',
        apiKind: 'systemone',
        model: request.model,
        userId: billing.userId,
        organizationId: billing.organizationId,
      }),
    ]);
  });

  it('releases a reservation it cannot settle and refuses the judge', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const sent = command(init);
      return sent.action === 'admit'
        ? Response.json({ kind: 'admitted', reservationId: sent.requestId, body: {} })
        : Response.json({ kind: 'released' });
    });
    expect(await admitJudgeInference(env, billing, request)).toBe('unavailable');
    const [admit, release] = commands();
    expect(release).toEqual(
      expect.objectContaining({ action: 'release', requestId: admit?.requestId })
    );
  });

  it.each([
    [402, 'insufficient'],
    [503, 'unavailable'],
  ] as const)('maps a definite no-hold rejection %s without a release', async (status, result) => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status, headers: { [INFERENCE_RESERVATION_STATE_HEADER]: 'none' } })
    );
    expect(await admitJudgeInference(env, billing, request)).toBe(result);
    expect(commands().map(command => command.action)).toEqual(['admit']);
  });

  it.each([
    ['an unknown hold state', async () => new Response(null, { status: 503 })],
    [
      'a lost acknowledgement',
      async () => {
        throw new Error('connection reset');
      },
    ],
  ])('releases after %s', async (_label, admit) => {
    fetchMock
      .mockImplementationOnce(admit)
      .mockResolvedValueOnce(Response.json({ kind: 'released' }));
    expect(await admitJudgeInference(env, billing, request)).toBe('unavailable');
    expect(commands().map(command => command.action)).toEqual(['admit', 'release']);
  });
});
