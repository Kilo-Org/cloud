import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProfileCreditBridge,
  ProfileCreditBridgeError,
  type ProfileCreditReserveRequest,
} from './profile-billing';

const request: ProfileCreditReserveRequest = {
  admissionId: 'admission-1',
  ownerType: 'org',
  ownerId: 'org-1',
  items: [
    { model: 'vendor/model', variant: 'high', estimatedCostUsd: 0.5 },
    { model: 'vendor/model', variant: null, estimatedCostUsd: 0.25 },
  ],
};
const held = {
  admissionId: request.admissionId,
  heldCostUsd: 0.75,
  items: request.items.map(item => ({ ...item, status: 'held', chargedCostUsd: null })),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('benchmark owner credit bridge', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const billing = createProfileCreditBridge({
    webUrl: 'https://web.example',
    internalApiSecret: 'test-internal-secret',
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reserves the complete exact-pair request with internal bearer authentication', async () => {
    fetchMock.mockResolvedValue(jsonResponse(held));
    await expect(billing.reserve(request)).resolves.toEqual({ kind: 'held' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      'https://web.example/api/internal/auto-routing-benchmark/billing/reserve'
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: ['Bearer', 'test-internal-secret'].join(' '),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  });

  it('keeps the same admission and exact pair payload on idempotent reserve replay', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(held));
    await billing.reserve(request);
    await billing.reserve(request);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toEqual(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it('reports insufficient credits without pretending a hold was confirmed', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'insufficient_credits', availableCostUsd: 0.1, requiredCostUsd: 0.75 },
        402
      )
    );
    await expect(billing.reserve(request)).resolves.toEqual({
      kind: 'insufficient',
      availableCostUsd: 0.1,
      requiredCostUsd: 0.75,
    });
  });

  it('rejects malformed or mismatched confirmed holds', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...held, admissionId: 'other-admission' }));
    await expect(billing.reserve(request)).rejects.toThrow('mismatched reservation');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...held, items: [held.items[0], held.items[0]] })
    );
    await expect(billing.reserve(request)).rejects.toThrow('mismatched reservation');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...held, items: held.items.map(item => ({ ...item, estimatedCostUsd: 1 })) })
    );
    await expect(billing.reserve(request)).rejects.toThrow('mismatched reservation');
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...held, heldCostUsd: -1 }));
    await expect(billing.reserve(request)).rejects.toThrow();
  });

  it('does not suppress unavailable, blocked, or conflicting bridge responses', async () => {
    for (const status of [403, 409, 503]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bridge error' }, status));
      await expect(billing.reserve(request)).rejects.toThrow(ProfileCreditBridgeError);
    }
  });

  it('settles the exact run and releases unused holds with null run and zero actual cost', async () => {
    const settlement = {
      admissionId: request.admissionId,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      model: 'vendor/model',
      variant: 'high',
      runId: 'run-1',
      actualCostUsd: 0.3,
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...settlement, chargedCostUsd: 0.3, releasedCostUsd: 0.2 })
    );
    await billing.settle(settlement);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://web.example/api/internal/auto-routing-benchmark/billing/settle'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(settlement));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...settlement, runId: null, chargedCostUsd: 0, releasedCostUsd: 0.5 })
    );
    await billing.settle({ ...settlement, runId: null, actualCostUsd: 0 });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ ...settlement, runId: null, actualCostUsd: 0 })
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bridge error' }, 503));
    await expect(billing.settle(settlement)).rejects.toThrow(ProfileCreditBridgeError);
  });

  it('retains settlement retries when a successful HTTP response has the wrong identity or charge', async () => {
    const settlement = {
      admissionId: request.admissionId,
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      model: 'vendor/model',
      variant: 'high',
      runId: 'run-1',
      actualCostUsd: 0.3000004,
    };
    const acknowledgement = { ...settlement, chargedCostUsd: 0.3, releasedCostUsd: 0.2 };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...acknowledgement, runId: 'another-run' }));
    await expect(billing.settle(settlement)).rejects.toThrow('mismatched settlement');
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...acknowledgement, chargedCostUsd: 0.31 }));
    await expect(billing.settle(settlement)).rejects.toThrow('mismatched settlement');
    fetchMock.mockResolvedValueOnce(jsonResponse(acknowledgement));
    await expect(billing.settle(settlement)).resolves.toBeUndefined();
  });
});
