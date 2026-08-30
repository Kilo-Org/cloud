import { expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { ErrorSchema } from '@kilocode/agent-harness/contracts';
import * as fixture from './operation-test-fixture';
import type * as Contract from './operation-contract';

const {
  HarnessOperationSchema,
  harnessOperationScope,
  harnessOperationFailure,
  safeError,
  bounded,
} = jest.requireActual<typeof Contract>('./operation-contract');
const { call, capability, authorizedInput, conversationId, operationId, runId } = fixture;
const identity = { conversationId, operationId };
const projection = {
  id: runId,
  key: 'projection',
  role: 'assistant',
  content: '',
  createdAt: '2026-08-30T00:00:00.000Z',
};
it.each([
  call(),
  { ...call(), type: 'reconcile' },
  { ...identity, type: 'read', purpose: 'read' },
  { ...identity, type: 'history' },
  { ...identity, type: 'projection', projection },
  { ...identity, type: 'retirement', generation: 0 },
])('authorizes strict $type wire input', async input => {
  await expect(authorizedInput(input)).resolves.toMatchObject({ authority: fixture.authority });
  expect(HarnessOperationSchema.safeParse({ ...input, userId: 'forged' }).success).toBe(false);
});
it.each([
  [{ ...identity, type: 'history', limit: undefined }, { limit: 50 }],
  [
    call('web.search', { query: 'kilo', limit: undefined }),
    { request: { arguments: { limit: 5 } } },
  ],
  [{ ...identity, type: 'projection', projection }, { projection: { clientId: null } }],
])('preserves schema defaults through signed JSON %#', async (input, expected) => {
  await expect(authorizedInput(input)).resolves.toMatchObject({ input: expected });
});
it('authorizes absent optional fields without inventing a dispatch timestamp', async () => {
  const input = {
    ...call('kilo.sessions.start', { prompt: 'Build', modelId: 'model', repository: undefined }),
    dispatchStartedAt: undefined,
    reservation: undefined,
  };
  const result = await authorizedInput(input);
  expect(harnessOperationScope(input)).toEqual(result.scope);
  expect(result.input).not.toHaveProperty('dispatchStartedAt');
  expect(result.input).not.toHaveProperty('reservation');
  expect(result.input).toMatchObject({
    request: { arguments: { prompt: 'Build', modelId: 'model' } },
  });
});
it('authorizes reordered arguments with the original capability', async () => {
  const token = capability(
    call('kilo.invite', { recipient: 'member@example.com', role: 'member' })
  );
  const input = call('kilo.invite', { role: 'member', recipient: 'member@example.com' });
  await expect(authorizedInput(input, token)).resolves.toMatchObject({
    authority: fixture.authority,
  });
});
it.each([
  { ...call(), type: 'arbitrary.trpc' },
  { ...call(), userId: 'forged' },
  { ...call(), userId: undefined },
  call('arbitrary.trpc'),
  call('kilo.organizations', { userId: 'forged' }),
  { ...call(), dispatchStartedAt: NaN },
  { ...call(), reservation: {} },
  { ...identity, type: 'history', limit: 51 },
  { ...identity, type: 'read', purpose: 'execute' },
  { ...identity, type: 'retirement', generation: -1 },
  { ...identity, type: 'projection', projection: { ...projection, token: 'secret' } },
])('rejects malformed input before wire normalization %#', input => {
  expect(HarnessOperationSchema.safeParse(input).success).toBe(false);
  expect(() => harnessOperationScope(input)).toThrow();
});
it.each([
  { type: 'reconcile' },
  { conversationId: runId },
  { operationId: runId },
  { runId: operationId },
  { toolCallId: operationId },
  { dispatchStartedAt: fixture.originalTime + 1 },
  { request: { name: 'kilo.members', arguments: {} } },
  { request: { name: 'web.search', arguments: { query: 'changed' } } },
])('rejects changed signed operation input %#', async patch => {
  const input = call('web.search', { query: 'kilo' });
  await expect(authorizedInput({ ...input, ...patch }, capability(input))).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});
it.each([
  ['SERVICE_UNAVAILABLE', 'unavailable_tool', true, false],
  ['PRECONDITION_FAILED', 'reauthorization_required', false, false],
  ['BAD_REQUEST', 'invalid_input', false, false],
  ['FORBIDDEN', 'access_revoked', false, false],
  ['TIMEOUT', 'storage_unavailable', true, false],
  ['TIMEOUT', 'outcome_unknown', false, true],
  ['PAYLOAD_TOO_LARGE', 'limit_exceeded', false, false],
  ['PAYLOAD_TOO_LARGE', 'outcome_unknown', false, true],
  ['BAD_REQUEST', 'invalid_input', false, true],
] as const)(
  'sanitizes %s without merging recovery states %#',
  (code, expected, retryable, uncertain) => {
    const failure = new TRPCError({
      code,
      message: code === 'PRECONDITION_FAILED' ? 'reauthorization_required' : 'provider-secret',
      cause: new Error('secret'),
    });
    const result = harnessOperationFailure(failure, uncertain);
    expect(result).toMatchObject({ error: { code: expected, retryable } });
    expect(JSON.stringify(result)).not.toContain('secret');
  }
);
it.each(ErrorSchema.shape.code.options)('redacts extra fields from %s errors', code => {
  const error = { code, message: 'secret', retryable: false, credentials: 'secret' };
  const result = safeError(error);
  expect(result).toEqual({ code, message: expect.any(String), retryable: false });
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('bounds UTF-8 output including JSON overhead', () => {
  expect(bounded('é', 4)).toBe('é');
  expect(() => bounded('é', 3)).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  expect(bounded('a'.repeat(65534))).toHaveLength(65534);
  expect(() => bounded('a'.repeat(65535))).toThrow(
    expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' })
  );
});
it.each([[], {}, null, ''])('preserves empty output %j', value => {
  expect(bounded(value)).toEqual(value);
});
it.each([undefined, 1n])('classifies non-JSON output %# as invalid, not retryable', value => {
  let failure: unknown;
  try {
    bounded(value);
  } catch (error) {
    failure = error;
  }
  expect(harnessOperationFailure(failure)).toMatchObject({
    error: { code: 'invalid_output', retryable: false },
  });
});
