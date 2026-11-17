import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import { isAutoTopUpInFlight } from '@kilocode/web-shared/lib/autoTopUpInFlight';
import type { GatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
  storableEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { promptScanParts } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { admitCompletionRouteGuardrail } from './completion-route';

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ENKRYPT_API_KEY: 'test-enkrypt-key',
}));
jest.mock('@kilocode/web-shared/lib/autoTopUpInFlight', () => ({
  isAutoTopUpInFlight: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server',
  () => ({
    getOrganizationGroupPolicyContext: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    mget: jest.fn((keys: string[]) => Promise.resolve(keys.map(() => null))),
    set: jest.fn(() => Promise.resolve('OK')),
  },
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage'
  ),
  recordEnkryptUsage: jest.fn(() => Promise.resolve()),
}));

const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;
const mockedIsAutoTopUpInFlight = jest.mocked(isAutoTopUpInFlight);
const mockedGetOrganizationGroupPolicyContext = jest.mocked(getOrganizationGroupPolicyContext);

const enkryptDetectUrl = 'https://api.enkryptai.com/guardrails/detect';
const promptText = 'const total = subtotal + tax';
/** The prompt as the conversation scan renders it. */
const renderedPrompt = `[user]\n${promptText}`;

const user = { id: 'user-1' } as User;
const organizationCaller: GatewayCaller = {
  kind: 'signed-in',
  user,
  organizationId: 'org-1',
};
const personalCaller: GatewayCaller = {
  kind: 'signed-in',
  user,
  organizationId: undefined,
};

const groupId = '00000000-0000-4000-8000-000000000003';
const otherGroupId = '00000000-0000-4000-8000-000000000004';

const blockingDetectors = storableEnkryptInputDetectors({
  ...createKiloDefaultEnkryptInputDetectors(),
  injection_attack: { enabled: true, action: 'block' },
});

const inputGuardrail: OrganizationSettings = {
  kilo_encrypt: true,
  enkrypt: { input_guardrail: { enabled: true, detectors: blockingDetectors } },
};

const groupInputGuardrail: OrganizationSettings = {
  kilo_encrypt: true,
  enkrypt: {
    input_guardrail: { enabled: true, detectors: blockingDetectors, group_id: groupId },
  },
};

const outputGuardrail: OrganizationSettings = {
  kilo_encrypt: true,
  enkrypt: {
    output_guardrail: {
      enabled: true,
      detectors: {
        ...createEmptyEnkryptOutputDetectors(),
        pii: { enabled: true, action: 'block', entities: ['secrets'] },
      },
    },
  },
};

const noGuardrail: OrganizationSettings = {
  kilo_encrypt: true,
  enkrypt: { input_guardrail: { enabled: false } },
};

const allowed = { summary: { injection_attack: 0, pii: 0 }, result_message: null };
const injection = {
  summary: { injection_attack: 1, pii: 0 },
  result_message: 'Potential prompt injection detected.',
};

function account(settings: OrganizationSettings, balanceMicrodollars: number) {
  return {
    settings,
    payer: {
      createdAt: '2026-01-01T00:00:00.000Z',
      totalMicrodollarsAcquired: 5_000_000,
      microdollarsUsed: 5_000_000 - balanceMicrodollars,
    },
  };
}

type GuardrailInput = Parameters<typeof admitCompletionRouteGuardrail>[0];

function requestInput(overrides: Partial<GuardrailInput> = {}): GuardrailInput {
  return {
    caller: organizationCaller,
    account: account(inputGuardrail, 1),
    organizationId: 'org-1',
    kiloUserId: 'user-1',
    apiKind: 'fim_completions',
    sessionId: null,
    clientRequestId: null,
    parts: promptScanParts([{ header: 'user', body: promptText }]),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function enkryptAnswers(body: unknown) {
  mockedFetch.mockResolvedValue(
    Response.json(body, { headers: { 'x-enkrypt-credits-cost': '2' } })
  );
}

/** The bodies of the Enkrypt detect calls this test made, in order. */
function detectRequestBodies(): { text: string }[] {
  return mockedFetch.mock.calls
    .filter(([url]) => url === enkryptDetectUrl)
    .map(([, init]) => JSON.parse(init?.body as string) as { text: string });
}

async function admit(input: GuardrailInput) {
  const result = await admitCompletionRouteGuardrail(input);
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') throw new Error('expected the request to be admitted');
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFetch.mockReset();
  mockedIsAutoTopUpInFlight.mockReset();
  mockedIsAutoTopUpInFlight.mockResolvedValue(false);
  mockedGetOrganizationGroupPolicyContext.mockReset();
  mockedGetOrganizationGroupPolicyContext.mockResolvedValue({ groupIds: [] } as never);
  globalThis.fetch = mockedFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('admitCompletionRouteGuardrail', () => {
  it('admits a caller without an organization and never reads member groups', async () => {
    const result = await admit(
      requestInput({
        caller: personalCaller,
        organizationId: undefined,
        account: account(inputGuardrail, 0),
      })
    );

    expect(result.outputScan).toBeNull();
    expect(await result.rejectIfBlocked()).toBeNull();
    expect(mockedGetOrganizationGroupPolicyContext).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('admits a funded organization and allows the prompt its guardrail scanned', async () => {
    enkryptAnswers(allowed);

    const result = await admit(requestInput({ account: account(inputGuardrail, 1) }));

    expect(await result.rejectIfBlocked()).toBeNull();
    expect(detectRequestBodies()).toEqual([expect.objectContaining({ text: renderedPrompt })]);
  });

  it('requires a positive organization balance for a guarded organization', async () => {
    const result = await admitCompletionRouteGuardrail(
      requestInput({ account: account(inputGuardrail, 0) })
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') return;
    expect(result.response.status).toBe(402);
    expect(await result.response.json()).toMatchObject({
      error_type: 'usage_limit_exceeded',
      error: { title: 'Organization Credits Required', balance: 0 },
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects a FIM completion with a 400 when a blocking detector fires', async () => {
    enkryptAnswers(injection);

    const result = await admit(requestInput({ apiKind: 'fim_completions' }));

    const rejection = await result.rejectIfBlocked();
    expect(rejection).not.toBeNull();
    if (!rejection) return;
    expect(rejection.status).toBe(400);
    expect(rejection.headers.get('x-should-retry')).toBe('false');
    const body = (await rejection.json()) as { error: string; error_type: string };
    expect(Object.keys(body).toSorted()).toEqual(['error', 'error_type']);
    expect(body.error_type).toBe('guardrail_blocked');
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('detected: injection_attack');
    expect(body.error).toContain('Potential prompt injection detected.');
  });

  describe('input guardrail limited to a group', () => {
    it('admits a member outside the guardrail group', async () => {
      mockedGetOrganizationGroupPolicyContext.mockResolvedValue({
        groupIds: [otherGroupId],
      } as never);

      const result = await admit(requestInput({ account: account(groupInputGuardrail, 1) }));

      expect(await result.rejectIfBlocked()).toBeNull();
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedGetOrganizationGroupPolicyContext).toHaveBeenCalledTimes(1);
      expect(mockedGetOrganizationGroupPolicyContext).toHaveBeenCalledWith({
        organizationId: 'org-1',
        subject: { type: 'member', kiloUserId: 'user-1' },
        fromDb: expect.anything(),
      });
    });

    it('scans a member of the group', async () => {
      enkryptAnswers(allowed);
      mockedGetOrganizationGroupPolicyContext.mockResolvedValue({ groupIds: [groupId] } as never);

      const result = await admit(requestInput({ account: account(groupInputGuardrail, 1) }));

      expect(await result.rejectIfBlocked()).toBeNull();
      expect(detectRequestBodies()).toEqual([expect.objectContaining({ text: renderedPrompt })]);
    });
  });

  it('resolves the output scan of an organization that has one', async () => {
    const result = await admit(requestInput({ account: account(outputGuardrail, 1) }));

    expect(result.outputScan).toEqual({
      sessionId: null,
      organizationId: 'org-1',
      kiloUserId: 'user-1',
      apiKind: 'fim_completions',
      clientRequestId: null,
      config: expect.objectContaining({ status: 'ready' }),
    });
  });

  it('resolves no output scan for an organization without one', async () => {
    const result = await admit(requestInput({ account: account(noGuardrail, 0) }));

    expect(result.outputScan).toBeNull();
  });
});
