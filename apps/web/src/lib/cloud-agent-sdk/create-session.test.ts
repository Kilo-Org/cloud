import { createSessionResponseV1Schema, parseCreateSessionResponse } from './create-session';

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
