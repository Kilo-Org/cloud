import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TRPCClientError } from '@trpc/client';
import { getTRPCErrorFromUnknown, TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
import type { z } from 'zod';
import {
  basePrepareSessionNextSchema,
  baseSendMessageNextSchema,
} from '@/routers/cloud-agent-next-schemas';
import {
  caller,
  cloudId,
  fixture,
  guard,
  invocation,
  message,
  operationId,
  org,
  reference,
  sessionId,
} from './cloud-agent-test-fixture';
import type * as Adapter from './cloud-agent';

let loss: 'prepare' | 'admission' | 'response' | undefined;
let admissionError: unknown;
let ledger: Record<string, unknown> | undefined;
let responseChange: Record<string, string>;
jest.mock('@/lib/drizzle', () => ({
  db: {
    query: {
      operation_ledgers: { findFirst: async () => (fixture.hideEvidence ? undefined : ledger) },
    },
  },
}));
function cloud(scoped: boolean) {
  const check = (input: { organizationId?: string }) => {
    guard(scoped ? input.organizationId : null);
    if (admissionError) throw admissionError;
  };
  const settle = <T>(effect: string, result: T) => {
    fixture.effects.push(effect);
    if (loss)
      throw getTRPCErrorFromUnknown(TRPCClientError.from(new Error('secret-provider-error')));
    return result;
  };
  return {
    prepareSession: async (
      input: z.input<typeof basePrepareSessionNextSchema> & { organizationId?: string }
    ) => {
      check(input);
      const prepared = basePrepareSessionNextSchema.parse(input);
      if (fixture.unavailable) throw new TRPCError({ code: 'PAYMENT_REQUIRED' });
      if (
        !prepared.autoInitiate ||
        prepared.operationKey !== operationId ||
        !prepared.initialMessageId
      )
        throw new Error('Missing durable admission');
      const result = { kiloSessionId: sessionId, cloudAgentSessionId: cloudId };
      ledger = {
        organization_id: fixture.organizationId,
        status: 'admitted',
        canonical_result: { ...result, initialMessageId: prepared.initialMessageId },
      };
      if (loss !== 'prepare') {
        fixture.messages = [message(prepared.initialMessageId, prepared.prompt ?? '')];
        ledger.status = loss === 'admission' ? 'reconcile_pending' : 'completed';
      }
      return settle('start', result);
    },
    sendMessage: async (
      input: z.input<typeof baseSendMessageNextSchema> & { organizationId?: string }
    ) => {
      check(input);
      const sent = baseSendMessageNextSchema.parse(input);
      if (fixture.unavailable) throw new TRPCError({ code: 'PAYMENT_REQUIRED' });
      if (
        sent.cloudAgentSessionId !== cloudId ||
        !sent.messageId ||
        sent.payload.type !== 'prompt' ||
        sent.payload.model !== 'model' ||
        sent.payload.mode !== fixture.mode
      )
        throw new Error('Wrong continuation');
      fixture.messages = [message(sent.messageId, sent.payload.prompt)];
      return settle('continue', {
        cloudAgentSessionId: cloudId,
        messageId: sent.messageId,
        streamUrl: 'secret-stream-ticket',
        ...responseChange,
      });
    },
    interruptSession: async (input: { sessionId: string; organizationId?: string }) => {
      check(input);
      if (input.sessionId !== cloudId) throw new Error('Wrong stop target');
      return settle('stop', { success: true });
    },
  };
}
Object.assign(caller.cloudAgentNext, cloud(false));
Object.assign(caller.organizations.cloudAgentNext, cloud(true));
// The repository transformer does not hoist mocks.
const { executeHarnessCloudAgent, reconcileHarnessCloudAgent } =
  jest.requireActual<typeof Adapter>('./cloud-agent');
const cases = [
  ['start', { prompt: 'fix', modelId: 'model', repository: 'owner/repo' }],
  ['continue', { ...reference, message: 'continue' }],
  ['stop', reference],
] as const;
const invoke = (name: string, args: unknown, reconcile = false) =>
  (reconcile ? reconcileHarnessCloudAgent : executeHarnessCloudAgent)(
    `kilo.sessions.${name}`,
    invocation(name, args)
  );
beforeEach(() => {
  loss = undefined;
  admissionError = undefined;
  ledger = undefined;
  responseChange = {};
});
describe.each([null, org])('authorized Cloud Agent context %s', scope => {
  beforeEach(() => {
    fixture.organizationId = fixture.sessionScope = scope;
  });
  it.each(cases)('keeps remote %s rejection terminal without an effect', async (name, args) => {
    for (const code of [
      'UNAUTHORIZED',
      'FORBIDDEN',
      'BAD_REQUEST',
      'PRECONDITION_FAILED',
      'PAYMENT_REQUIRED',
    ] as const) {
      admissionError = getTRPCErrorFromUnknown(
        TRPCClientError.from({
          error: {
            message: 'secret-provider-error',
            code: TRPC_ERROR_CODES_BY_KEY[code],
            data: { code, httpStatus: getHTTPStatusCodeFromError(new TRPCError({ code })) },
          },
        })
      );
      await expect(invoke(name, args)).rejects.toMatchObject({
        code,
        message: 'Cloud Agent rejected this operation.',
        cause: undefined,
      });
      expect(ledger).toBeUndefined();
      expect(fixture.effects).toEqual([]);
    }
  });
  it.each(cases)('executes %s with private output and real session linkage', async (name, args) => {
    const outcome = await invoke(name, args);
    expect(outcome).toEqual({ status: 'succeeded', output: reference });
    expect(fixture.effects).toEqual([name]);
    if (name === 'start' && outcome.status === 'succeeded')
      expect(await invoke('progress', outcome.output)).toEqual({
        status: 'succeeded',
        output: { ...reference, status: 'running' },
      });
  });
  it.each(cases)('denies removed membership for %s', async (name, args) => {
    fixture.revoked = true;
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.effects).toEqual([]);
  });
  it.each([cases[1], cases[2]])('rejects a context mismatch for %s', async (name, args) => {
    fixture.sessionScope = scope === null ? org : null;
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.effects).toEqual([]);
  });
  it.each([cases[0], cases[1]])('preserves model eligibility for %s', async (name, args) => {
    fixture.unavailable = true;
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(fixture.effects).toEqual([]);
  });
  it.each([
    ['response', ...cases[0]],
    ['response', ...cases[1]],
    ['response', ...cases[2]],
    ['prepare', ...cases[0]],
    ['admission', ...cases[0]],
  ] as const)('reconciles %s loss for %s without redispatch', async (phase, name, args) => {
    loss = phase;
    expect(await invoke(name, args)).toMatchObject({ status: 'outcome_unknown' });
    fixture.hideEvidence = true;
    expect(await invoke(name, args, true)).toMatchObject({ status: 'outcome_unknown' });
    fixture.hideEvidence = false;
    expect(await invoke(name, args, true)).toMatchObject({
      status: name === 'stop' || phase === 'prepare' ? 'outcome_unknown' : 'succeeded',
    });
    if (name === 'stop') {
      jest
        .spyOn(caller.cliSessionsV2, 'get')
        .mockRejectedValueOnce(new TRPCError({ code: 'NOT_FOUND' }));
      expect(await invoke(name, args, true)).toMatchObject({ status: 'outcome_unknown' });
    }
    expect(fixture.effects).toEqual([name]);
  });
  it.each(['failed', 'no_op', 'interrupted', 'superseded', 'unknown'])(
    'never confirms a %s create through matching history',
    async status => {
      loss = 'admission';
      await invoke(...cases[0]);
      ledger!.status = status;
      expect(await invoke(...cases[0], true)).toMatchObject({ status: 'outcome_unknown' });
      expect(fixture.effects).toEqual(['start']);
    }
  );
  it.each([cases[0], cases[1]])('requires the exact user turn for %s', async (name, args) => {
    loss = 'admission';
    await invoke(name, args);
    const turn = fixture.messages[0];
    const content = name === 'start' ? cases[0][1].prompt : cases[1][1].message;
    for (const messages of [
      [],
      [message('another-id', content)],
      [message(turn.info.id, 'wrong content')],
      [message(turn.info.id, content, 'assistant')],
    ]) {
      fixture.messages = messages;
      expect(await invoke(name, args, true)).toMatchObject({ status: 'outcome_unknown' });
    }
    fixture.messages = [turn];
    expect(await invoke(name, args, true)).toEqual({ status: 'succeeded', output: reference });
    expect(fixture.effects).toEqual([name]);
  });
  it.each(['cloudAgentSessionId', 'messageId'])('rejects a mismatched response %s', async key => {
    responseChange = { [key]: 'another-identity' };
    expect(await invoke(...cases[1])).toMatchObject({ status: 'outcome_unknown' });
    fixture.messages = [];
    expect(await invoke(...cases[1], true)).toMatchObject({ status: 'outcome_unknown' });
    expect(fixture.effects).toEqual(['continue']);
  });
  it.each([cases[1], cases[2]])('rechecks the grant before %s', async (name, args) => {
    const api = scope === null ? caller.cloudAgentNext : caller.organizations.cloudAgentNext;
    const getState = api.getSession,
      getOwned = caller.cliSessionsV2.get;
    const revoke = <T>(result: T) => {
      fixture.grantRevoked = true;
      return result;
    };
    if (name === 'continue')
      jest.spyOn(api, 'getSession').mockImplementationOnce(input => getState(input).then(revoke));
    else
      jest
        .spyOn(caller.cliSessionsV2, 'get')
        .mockImplementationOnce(input => getOwned(input).then(revoke));
    await expect(invoke(name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.effects).toEqual([]);
  });
  it.each([
    ['search', { query: 'absent' }, []],
    ['attach', reference, { ...reference, untrusted: true, messages: [] }],
    ['progress', reference, { ...reference, status: 'idle' }],
  ] as const)(
    'delegates empty %s reads during execution and reconciliation',
    async (name, args, output) => {
      fixture.hideEvidence = true;
      for (const reconcile of [false, true])
        expect(await invoke(name, args, reconcile)).toEqual({ status: 'succeeded', output });
      expect(fixture.effects).toEqual([]);
    }
  );
});
