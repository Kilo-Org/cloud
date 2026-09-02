import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import {
  CheckError,
  mintBootstrapToken,
  runningNativeHold,
  matchesNativeHold,
  assertNativeHoldOverlap,
  assertNoNativeCompletion,
  hasNativeCancellation,
  type NativeHold,
  type NativeTurn,
  type Part,
} from './multichat-real-support.js';

const secret = randomBytes(32).toString('hex');
const userId = 'multichat-unit-fixture';
const pepper = 'unit-fixture-pepper';

function fixture(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId,
    token: jwt.sign(
      {
        version: 3,
        kiloUserId: userId,
        env: 'production',
        apiTokenPepper: pepper,
        iat: now,
        exp: now + 7200,
        ...claims,
      },
      secret,
      { algorithm: 'HS256' }
    ),
  };
}

for (const env of ['production', 'development']) {
  void test(`verified ${env} fixture mints exact local Next dev cloud-agent claims`, () => {
    const auth = fixture({ env });
    const original = auth.token;
    const before = Math.floor(Date.now() / 1000);
    const token = mintBootstrapToken(auth, secret);
    const verified = jwt.verify(token, secret, { algorithms: ['HS256'] });
    assert.equal(typeof verified, 'object');
    assert(typeof verified === 'object');
    const { iat, exp, ...claims } = verified;
    assert.deepEqual(claims, {
      env: 'development',
      kiloUserId: userId,
      apiTokenPepper: pepper,
      version: 3,
      tokenSource: 'cloud-agent',
    });
    assert(typeof iat === 'number' && typeof exp === 'number');
    assert(iat >= before && iat <= Math.floor(Date.now() / 1000));
    assert.equal(exp - iat, 3600);
    assert(auth.token === original, 'The original web bearer must remain unchanged');
  });
}

void test('bootstrap preserves null pepper and never extends fixture expiry', () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3000;
  const token = mintBootstrapToken(
    fixture({ apiTokenPepper: null, exp: expiresAt, tokenSource: 'cloud-agent' }),
    secret
  );
  const verified = jwt.verify(token, secret, { algorithms: ['HS256'] });
  assert(typeof verified === 'object');
  assert.equal(verified.apiTokenPepper, null);
  assert.equal(verified.exp, expiresAt);
});

void test('bootstrap rejects a different signing key', () => {
  assert.throws(() => mintBootstrapToken(fixture(), `${secret}-other`), CheckError);
});

void test('bootstrap rejects a different fixture user', () => {
  assert.throws(
    () => mintBootstrapToken({ ...fixture(), userId: 'another-user' }, secret),
    CheckError
  );
});

const forbiddenClaims: { name: string; claims: Record<string, unknown> }[] = [
  { name: 'unsupported environment', claims: { env: 'test' } },
  { name: 'unsupported version', claims: { version: 2 } },
  { name: 'admin claim', claims: { isAdmin: true } },
  { name: 'organization scope', claims: { organizationId: 'another-organization' } },
  { name: 'audience scope', claims: { aud: 'another-service' } },
  { name: 'unknown claim', claims: { unknownPermission: true } },
  { name: 'different token source', claims: { tokenSource: 'cli' } },
  { name: 'missing pepper', claims: { apiTokenPepper: undefined } },
];
for (const { name, claims } of forbiddenClaims) {
  void test(`bootstrap rejects ${name} rather than stripping it`, () => {
    assert.throws(() => mintBootstrapToken(fixture(claims), secret), CheckError);
  });
}

void test('bootstrap rejects expired fixtures', () => {
  assert.throws(
    () => mintBootstrapToken(fixture({ exp: Math.floor(Date.now() / 1000) - 1 }), secret),
    CheckError
  );
});

void test('bootstrap rejects future issuance', () => {
  assert.throws(
    () => mintBootstrapToken(fixture({ iat: Math.floor(Date.now() / 1000) + 120 }), secret),
    CheckError
  );
});

void test('bootstrap rejects fixtures that cannot cover the full run', () => {
  assert.throws(
    () => mintBootstrapToken(fixture({ exp: Math.floor(Date.now() / 1000) + 2400 }), secret),
    CheckError
  );
});

const hold: NativeHold = {
  partId: 'part-hold',
  callId: 'call-hold',
  messageId: 'assistant-hold',
  startedAt: 1000,
  seconds: 180,
};
function holdPart(
  status: 'running' | 'completed' | 'error' = 'running',
  start = 1000,
  end = 181000
): Part {
  return {
    id: hold.partId,
    callID: hold.callId,
    messageID: hold.messageId,
    sessionID: 'session',
    type: 'tool',
    tool: 'bash',
    state: {
      status,
      input: { command: 'sleep 180' },
      error: status === 'error' ? 'Tool execution aborted' : undefined,
      time: status === 'running' ? { start } : { start, end },
    },
  };
}
function cancelledTurn(): NativeTurn {
  return {
    messages: [
      {
        id: hold.messageId,
        sessionID: 'session',
        role: 'assistant',
        parentID: 'prompt',
        finish: 'tool-calls',
        time: { completed: 1100 },
      },
    ],
    tools: [holdPart('error')],
  };
}

void test('admission alone or a finished hold cannot establish native overlap', () => {
  assert.equal(runningNativeHold([], 180), undefined);
  assert.equal(runningNativeHold([holdPart('completed')], 180), undefined);
  assert.equal(runningNativeHold([{ ...holdPart(), callID: undefined }], 180), undefined);
  assert.deepEqual(runningNativeHold([holdPart()], 180), hold);
});

void test('durably running turns with serial native tool intervals fail overlap', () => {
  assert.throws(
    () =>
      assertNativeHoldOverlap([
        holdPart('completed', 1000, 10000),
        holdPart('completed', 2000, 4000),
        holdPart('completed', 4000, 8000),
      ]),
    CheckError
  );
});

void test('three completed native tool intervals prove real overlap', () => {
  assert.deepEqual(
    assertNativeHoldOverlap([
      holdPart('completed', 1000, 10000),
      holdPart('completed', 2000, 6000),
      holdPart('completed', 4000, 8000),
    ]),
    { start: 4000, end: 6000, overlapMs: 2000 }
  );
});

void test('stale running snapshots and sub-second intersections cannot prove overlap', () => {
  assert.throws(() => assertNativeHoldOverlap([holdPart(), holdPart()]), CheckError);
  assert.throws(
    () =>
      assertNativeHoldOverlap([
        holdPart('completed', 1000, 3000),
        holdPart('completed', 2500, 4000),
      ]),
    CheckError
  );
});

void test('exact native tool cancellation passes despite completed tool-step timestamp', () => {
  assert.equal(hasNativeCancellation(cancelledTurn(), hold), true);
});

void test('pre-Stop read and completed timestamp do not prove native cancellation', () => {
  const turn = cancelledTurn();
  turn.tools = [{ ...holdPart('completed'), id: 'read-part', tool: 'read' }];
  assert.equal(hasNativeCancellation(turn, hold), false);
  turn.tools = [holdPart()];
  assert.equal(hasNativeCancellation(turn, hold), false);
});

void test('cancellation requires the captured part, call, assistant and start identity', () => {
  for (const replacement of [
    { id: 'another-part' },
    { callID: 'another-call' },
    { messageID: 'another-assistant' },
    { state: { ...holdPart('error').state, status: 'error', time: { start: 2000, end: 3000 } } },
  ]) {
    const part = { ...holdPart('error'), ...replacement };
    assert.equal(matchesNativeHold(part, hold), false);
    assert.equal(hasNativeCancellation({ ...cancelledTurn(), tools: [part] }, hold), false);
  }
});

void test('unrelated tool error is not cancellation without a matching MessageAbortedError', () => {
  const turn = cancelledTurn();
  turn.tools = [
    {
      ...holdPart('error'),
      state: { ...holdPart('error').state, status: 'error', error: 'Command timed out' },
    },
  ];
  assert.equal(hasNativeCancellation(turn, hold), false);
  turn.messages[0] = {
    ...turn.messages[0],
    id: hold.messageId,
    sessionID: 'session',
    role: 'assistant',
    error: { name: 'MessageAbortedError' },
  };
  assert.equal(hasNativeCancellation(turn, hold), true);
});

function abortedShellTurn(): NativeTurn {
  const turn = cancelledTurn();
  turn.messages[0] = {
    ...turn.messages[0],
    id: hold.messageId,
    sessionID: 'session',
    role: 'assistant',
    error: { name: 'MessageAbortedError' },
  };
  turn.tools = [
    {
      ...holdPart('completed', 1000, 1261),
      state: {
        ...holdPart('completed', 1000, 1261).state,
        status: 'completed',
        output: '(no output)\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>',
        metadata: { exit: null },
      },
    },
  ];
  return turn;
}

void test('Kilo shell abort metadata and matching assistant abort prove early cancellation', () => {
  assert.equal(hasNativeCancellation(abortedShellTurn(), hold), true);
});

void test('shell abort result waits for matching assistant abort evidence', () => {
  const turn = abortedShellTurn();
  turn.messages = [];
  assert.equal(hasNativeCancellation(turn, hold), false);
});

for (const replacement of [
  { metadata: { exit: 0 } },
  { metadata: undefined },
  { output: 'User aborted the command' },
  { time: { start: 1000, end: 181000 } },
]) {
  void test(`ordinary completed hold cannot masquerade as shell abort: ${JSON.stringify(replacement)}`, () => {
    const turn = abortedShellTurn();
    turn.tools = turn.tools.map(part => ({
      ...part,
      state: { ...part.state, status: 'completed', ...replacement },
    }));
    assert.throws(() => hasNativeCancellation(turn, hold), CheckError);
  });
}

void test('successful stopped-tool completion fails even alongside assistant abort evidence', () => {
  const turn = cancelledTurn();
  turn.tools.push(holdPart('completed'));
  turn.messages.push({
    id: 'aborted',
    sessionID: 'session',
    role: 'assistant',
    error: { name: 'MessageAbortedError' },
  });
  assert.throws(() => hasNativeCancellation(turn, hold), CheckError);
});

for (const finish of ['stop', 'end_turn', 'length', 'unknown']) {
  void test(`later error-free ${finish} finish cannot be hidden by cancellation or a later abort update`, () => {
    const turn = cancelledTurn();
    turn.messages.push({
      id: 'later',
      sessionID: 'session',
      role: 'assistant',
      parentID: 'prompt',
      finish,
    });
    turn.messages.push({
      id: 'later',
      sessionID: 'session',
      role: 'assistant',
      parentID: 'prompt',
      finish,
      error: { name: 'MessageAbortedError' },
    });
    assert.throws(() => assertNoNativeCompletion(turn, hold), CheckError);
  });
}
