import { beforeEach, describe, expect, it } from '@jest/globals';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import type { User } from '@kilocode/db/schema';
import { isAutoTopUpInFlight } from '@kilocode/web-shared/lib/autoTopUpInFlight';
import type { GatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { admitEnkryptGuardrail } from './admission';

jest.mock('@kilocode/web-shared/lib/autoTopUpInFlight');

const mockedIsAutoTopUpInFlight = jest.mocked(isAutoTopUpInFlight);

const organizationCaller: GatewayCaller = {
  kind: 'signed-in',
  user: { id: 'user-1' } as User,
  organizationId: 'org-1',
};

const inputGuardrail: OrganizationSettings = {
  kilo_encrypt: true,
  enkrypt: { input_guardrail: { enabled: true } },
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

describe('admitEnkryptGuardrail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsAutoTopUpInFlight.mockResolvedValue(false);
  });

  it('admits a funded organization with its input guardrail', async () => {
    const admission = await admitEnkryptGuardrail(organizationCaller, account(inputGuardrail, 1));

    expect(admission).toEqual({
      kind: 'admitted',
      inputGuardrail: {
        organizationId: 'org-1',
        kiloUserId: 'user-1',
        config: expect.objectContaining({ status: 'ready' }),
      },
    });
  });

  it.each([0, -1_000_000])(
    'rejects an input guardrail at balance %s microdollars',
    async balance => {
      const admission = await admitEnkryptGuardrail(
        organizationCaller,
        account(inputGuardrail, balance)
      );

      expect(admission.kind).toBe('rejected');
      if (admission.kind !== 'rejected') return;
      expect(admission.response.status).toBe(402);
      expect(await admission.response.json()).toMatchObject({
        error: { title: 'Organization Credits Required', balance: balance / 1_000_000 },
      });
    }
  );

  it('rejects when every input detector is log-only', async () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.action = 'log';
    const settings: OrganizationSettings = {
      kilo_encrypt: true,
      enkrypt: { input_guardrail: { enabled: true, detectors } },
    };

    const admission = await admitEnkryptGuardrail(organizationCaller, account(settings, 0));

    expect(admission.kind).toBe('rejected');
  });

  it('rejects an output-only guardrail without starting an input scan', async () => {
    const settings: OrganizationSettings = {
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

    expect((await admitEnkryptGuardrail(organizationCaller, account(settings, 0))).kind).toBe(
      'rejected'
    );
    expect(await admitEnkryptGuardrail(organizationCaller, account(settings, 1))).toEqual({
      kind: 'admitted',
      inputGuardrail: null,
    });
  });

  it('rejects a caller without a payer row', async () => {
    const admission = await admitEnkryptGuardrail(organizationCaller, { settings: inputGuardrail });

    expect(admission.kind).toBe('rejected');
  });

  it('returns a retryable response while an organization top-up is in flight', async () => {
    mockedIsAutoTopUpInFlight.mockResolvedValue(true);

    const admission = await admitEnkryptGuardrail(organizationCaller, account(inputGuardrail, 0));

    expect(admission.kind).toBe('rejected');
    if (admission.kind !== 'rejected') return;
    expect(admission.response.status).toBe(503);
    expect(mockedIsAutoTopUpInFlight).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it.each<{ name: string; caller: GatewayCaller; settings: OrganizationSettings }>([
    {
      name: 'an organization without a guardrail',
      caller: organizationCaller,
      settings: { kilo_encrypt: true, enkrypt: { input_guardrail: { enabled: false } } },
    },
    {
      name: 'a personal request',
      caller: { ...organizationCaller, organizationId: undefined },
      settings: inputGuardrail,
    },
  ])('admits $name regardless of balance', async ({ caller, settings }) => {
    const admission = await admitEnkryptGuardrail(caller, account(settings, 0));

    expect(admission).toEqual({ kind: 'admitted', inputGuardrail: null });
    expect(mockedIsAutoTopUpInFlight).not.toHaveBeenCalled();
  });
});
