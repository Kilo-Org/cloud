import {
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
});
