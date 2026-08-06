import {
  classifyCreateSessionResult,
  createRemoteSessionOnConnection,
  createSessionResponseV1Schema,
  parseCreateSessionResponse,
} from './create-session';
import { CommandDeliveredError, UserWebCommandError } from './user-web-connection';

const VALID_SESSION_ID = 'ses_12345678901234567890123456';

describe('createSessionResponseV1Schema', () => {
  it('accepts a minimal valid v1 envelope', () => {
    const result = createSessionResponseV1Schema.safeParse({
      protocolVersion: 1,
      sessionID: VALID_SESSION_ID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ protocolVersion: 1, sessionID: VALID_SESSION_ID });
    }
  });

  it('rejects a wrong protocol version', () => {
    expect(
      createSessionResponseV1Schema.safeParse({ protocolVersion: 2, sessionID: VALID_SESSION_ID })
        .success
    ).toBe(false);
  });

  it('rejects a missing sessionID', () => {
    expect(createSessionResponseV1Schema.safeParse({ protocolVersion: 1 }).success).toBe(false);
  });

  it('rejects an empty sessionID', () => {
    expect(
      createSessionResponseV1Schema.safeParse({ protocolVersion: 1, sessionID: '' }).success
    ).toBe(false);
  });

  it('accepts a real generated-form KiloSessionId (hex timestamp + base62)', () => {
    const generatedLike = 'ses_0123456789ab0123456789abcd';
    expect(
      createSessionResponseV1Schema.safeParse({ protocolVersion: 1, sessionID: generatedLike })
        .success
    ).toBe(true);
  });

  it('rejects a sessionID that is one character too short', () => {
    expect(
      createSessionResponseV1Schema.safeParse({
        protocolVersion: 1,
        sessionID: 'ses_1234567890123456789012345',
      }).success
    ).toBe(false);
  });

  it('rejects a sessionID that is one character too long', () => {
    expect(
      createSessionResponseV1Schema.safeParse({
        protocolVersion: 1,
        sessionID: 'ses_123456789012345678901234567',
      }).success
    ).toBe(false);
  });

  it('rejects a sessionID missing the ses_ prefix', () => {
    expect(
      createSessionResponseV1Schema.safeParse({
        protocolVersion: 1,
        sessionID: '12345678901234567890123456',
      }).success
    ).toBe(false);
  });

  it('rejects a sessionID with a trailing underscore instead of ses_', () => {
    expect(
      createSessionResponseV1Schema.safeParse({
        protocolVersion: 1,
        sessionID: 'se_12345678901234567890123456',
      }).success
    ).toBe(false);
  });

  it('rejects a non-string sessionID', () => {
    expect(
      createSessionResponseV1Schema.safeParse({ protocolVersion: 1, sessionID: 123 }).success
    ).toBe(false);
  });

  it('rejects extra fields', () => {
    expect(
      createSessionResponseV1Schema.safeParse({
        protocolVersion: 1,
        sessionID: VALID_SESSION_ID,
        extra: true,
      }).success
    ).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(createSessionResponseV1Schema.safeParse(null).success).toBe(false);
    expect(createSessionResponseV1Schema.safeParse(VALID_SESSION_ID).success).toBe(false);
    expect(createSessionResponseV1Schema.safeParse(1).success).toBe(false);
  });
});

describe('parseCreateSessionResponse', () => {
  it('returns the branded KiloSessionId for a valid envelope', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 1, sessionID: VALID_SESSION_ID });
    expect(result).toEqual({ ok: true, kiloSessionId: VALID_SESSION_ID });
  });

  it('rejects an envelope with a wrong protocol version', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 2, sessionID: VALID_SESSION_ID });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a missing sessionID', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 1 });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a non-string sessionID', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 1, sessionID: 42 });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an empty sessionID', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 1, sessionID: '' });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a sessionID that is not a KiloSessionId', () => {
    const result = parseCreateSessionResponse({ protocolVersion: 1, sessionID: 'ses_abc' });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects extra fields', () => {
    const result = parseCreateSessionResponse({
      protocolVersion: 1,
      sessionID: VALID_SESSION_ID,
      sneaky: 'value',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects null, undefined, and primitives', () => {
    expect(parseCreateSessionResponse(null)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCreateSessionResponse(undefined)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCreateSessionResponse(VALID_SESSION_ID)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseCreateSessionResponse(1)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('createRemoteSessionOnConnection', () => {
  function makeFakeConnection() {
    return {
      sendCommandToConnection: jest.fn(),
    };
  }

  it('issues a connection-scoped create_session with protocolVersion: 1 and the expected connectionId', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      sessionID: VALID_SESSION_ID,
    });

    const result = await createRemoteSessionOnConnection(connection, 'cli-owner-1');

    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    expect(parseCreateSessionResponse(result)).toEqual({
      ok: true,
      kiloSessionId: VALID_SESSION_ID,
    });
  });

  it('resolves with the raw reply and lets the caller see a malformed response', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({ not: 'a v1 envelope' });

    const result = await createRemoteSessionOnConnection(connection, 'cli-owner-1');

    expect(parseCreateSessionResponse(result)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('propagates a delivered bare-string error as a CommandDeliveredError', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('Session owner not found')
    );

    await expect(createRemoteSessionOnConnection(connection, 'cli-owner-1')).rejects.toBeInstanceOf(
      CommandDeliveredError
    );
  });

  it('propagates a structured UserWebCommandError as itself', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new UserWebCommandError({
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'upgrade required',
      })
    );

    await expect(createRemoteSessionOnConnection(connection, 'cli-owner-1')).rejects.toBeInstanceOf(
      UserWebCommandError
    );
  });

  it('propagates a transport-level rejection as a plain (non-CommandDeliveredError) Error', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(new Error('Connection destroyed'));

    const rejection = await createRemoteSessionOnConnection(connection, 'cli-owner-1').catch(
      (error: unknown) => error
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(CommandDeliveredError);
    expect(rejection).not.toBeInstanceOf(UserWebCommandError);
  });

  it('spreads defined inheritance fields into wire data', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      sessionID: VALID_SESSION_ID,
    });

    await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      agent: 'architect',
      model: { providerID: 'kilo', modelID: 'kilo-auto', variant: 'efficient' },
      orgId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });

    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'create_session',
      data: {
        protocolVersion: 1,
        agent: 'architect',
        model: { providerID: 'kilo', modelID: 'kilo-auto', variant: 'efficient' },
        orgId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
      expectedConnectionId: 'cli-owner-1',
    });
  });

  it('retries once with bare protocolVersion on exact invalid create_session command error', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection
      .mockRejectedValueOnce(new CommandDeliveredError('invalid create_session command'))
      .mockResolvedValueOnce({ protocolVersion: 1, sessionID: VALID_SESSION_ID });

    const result = await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      agent: 'code',
    });

    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(2);
    expect(connection.sendCommandToConnection).toHaveBeenNthCalledWith(1, {
      command: 'create_session',
      data: { protocolVersion: 1, agent: 'code' },
      expectedConnectionId: 'cli-owner-1',
    });
    expect(connection.sendCommandToConnection).toHaveBeenNthCalledWith(2, {
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    expect(parseCreateSessionResponse(result)).toEqual({
      ok: true,
      kiloSessionId: VALID_SESSION_ID,
    });
  });

  it('does not retry invalid create_session when wire data had no extended fields', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('invalid create_session command')
    );

    await expect(createRemoteSessionOnConnection(connection, 'cli-owner-1')).rejects.toBeInstanceOf(
      CommandDeliveredError
    );
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
  });

  it('does not retry other CommandDeliveredError messages', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('Session owner not found')
    );

    await expect(
      createRemoteSessionOnConnection(connection, 'cli-owner-1', { agent: 'code' })
    ).rejects.toBeInstanceOf(CommandDeliveredError);
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
  });

  it('surfaces the shared bad-sessionId string after one bare retry', async () => {
    // Same delivered string covers malformed sessionId (harmless retry).
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockRejectedValue(
      new CommandDeliveredError('invalid create_session command')
    );

    await expect(
      createRemoteSessionOnConnection(connection, 'cli-owner-1', { agent: 'code' })
    ).rejects.toBeInstanceOf(CommandDeliveredError);
    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(2);
    expect(connection.sendCommandToConnection).toHaveBeenLastCalledWith({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
  });

  it('forwards the caller mutationId as the extended wire identity (`${key}:ext`)', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue({
      protocolVersion: 1,
      sessionID: VALID_SESSION_ID,
    });

    await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });

    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(1);
    expect(connection.sendCommandToConnection).toHaveBeenCalledWith({
      command: 'create_session',
      data: { protocolVersion: 1, agent: 'code' },
      expectedConnectionId: 'cli-owner-1',
      mutationId: 'spawn-key-1:ext',
    });
  });

  it('uses the distinct bare identity (`${key}:bare`) for the old-CLI retry', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection
      .mockRejectedValueOnce(new CommandDeliveredError('invalid create_session command'))
      .mockResolvedValueOnce({ protocolVersion: 1, sessionID: VALID_SESSION_ID });

    const result = await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });

    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(2);
    expect(connection.sendCommandToConnection).toHaveBeenNthCalledWith(1, {
      command: 'create_session',
      data: { protocolVersion: 1, agent: 'code' },
      expectedConnectionId: 'cli-owner-1',
      mutationId: 'spawn-key-1:ext',
    });
    expect(connection.sendCommandToConnection).toHaveBeenNthCalledWith(2, {
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
      mutationId: 'spawn-key-1:bare',
    });
    expect(parseCreateSessionResponse(result)).toEqual({
      ok: true,
      kiloSessionId: VALID_SESSION_ID,
    });
  });

  it('keeps the extended and bare identities stable and distinct across attempts', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection
      .mockRejectedValueOnce(new CommandDeliveredError('invalid create_session command'))
      .mockResolvedValueOnce({ protocolVersion: 1, sessionID: VALID_SESSION_ID })
      .mockRejectedValueOnce(new CommandDeliveredError('invalid create_session command'))
      .mockResolvedValueOnce({ protocolVersion: 1, sessionID: VALID_SESSION_ID });

    await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });
    await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });

    const mutationIds = connection.sendCommandToConnection.mock.calls.map(
      call => (call[0] as { mutationId?: string }).mutationId
    );
    // Same key, same attempt → identical wire identity across calls.
    expect(mutationIds).toEqual([
      'spawn-key-1:ext',
      'spawn-key-1:bare',
      'spawn-key-1:ext',
      'spawn-key-1:bare',
    ]);
    // The two durable identities must never collide.
    expect(new Set(mutationIds).size).toBe(2);
  });

  it('omits mutationId on both attempts when the caller provides none', async () => {
    const connection = makeFakeConnection();
    connection.sendCommandToConnection
      .mockRejectedValueOnce(new CommandDeliveredError('invalid create_session command'))
      .mockResolvedValueOnce({ protocolVersion: 1, sessionID: VALID_SESSION_ID });

    await createRemoteSessionOnConnection(connection, 'cli-owner-1', { agent: 'code' });

    expect(connection.sendCommandToConnection).toHaveBeenCalledTimes(2);
    for (const call of connection.sendCommandToConnection.mock.calls) {
      expect(call[0]).not.toHaveProperty('mutationId');
    }
  });

  it('classifies a durable-replayed envelope identically to a live envelope', async () => {
    // A D8 durable 'done' entry replays the exact stored envelope under the
    // retry request's id. The classifier must produce the same output for the
    // replayed envelope as for the original live delivery.
    const envelope = { protocolVersion: 1, sessionID: VALID_SESSION_ID };

    const connection = makeFakeConnection();
    connection.sendCommandToConnection.mockResolvedValue(envelope);
    const live = await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });

    connection.sendCommandToConnection.mockResolvedValue(envelope);
    const replayed = await createRemoteSessionOnConnection(connection, 'cli-owner-1', {
      mutationId: 'spawn-key-1',
      agent: 'code',
    });

    const liveOutcome = classifyCreateSessionResult({ status: 'fulfilled', value: live });
    const replayedOutcome = classifyCreateSessionResult({ status: 'fulfilled', value: replayed });
    expect(replayedOutcome).toEqual(liveOutcome);
    expect(replayedOutcome).toEqual({ status: 'ready', sessionID: VALID_SESSION_ID });
  });
});

describe('classifyCreateSessionResult', () => {
  it('returns retryable for a COMMAND_ALREADY_PENDING same-key in-flight dedupe', () => {
    // The relay emits this structured code when a same-mutationId duplicate
    // arrives while the command is in flight or its durable entry is pending.
    // The intent is NOT terminal: the retry must keep the operation key so
    // the DO replays the durable terminal result instead of dispatching a
    // second command (which a key rotation's new mutation identity would do).
    const cause = new UserWebCommandError({
      code: 'COMMAND_ALREADY_PENDING',
      message: 'Command is already in flight',
    });
    const outcome = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(outcome).toEqual({
      status: 'retryable',
      reason: 'Command is already in flight',
      cause,
    });
  });

  it('returns nonRetryable for a structured UserWebCommandError with any other code', () => {
    const cause = new UserWebCommandError({
      code: 'SESSION_OWNER_CHANGED',
      message: 'Session owner changed',
    });
    const outcome = classifyCreateSessionResult({ status: 'rejected', reason: cause });
    expect(outcome).toEqual({
      status: 'nonRetryable',
      reason: 'Session owner changed',
      cause,
    });
  });
});
