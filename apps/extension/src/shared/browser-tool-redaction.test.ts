/* eslint-disable max-lines -- one suite per replacement rule; the expected strings keep the input key order */
/* eslint-disable sort-keys -- the expected string preserves the input JSON key order */
import { describe, expect, it } from 'vitest';
import {
  redactSensitiveBase64Body,
  redactSensitiveBody,
  redactSensitiveHeaders,
} from './browser-tool-redaction';

const encode = (text: string): string => btoa(text);

describe('header redaction', () => {
  it('replaces the values of listed header names', () => {
    expect(
      redactSensitiveHeaders({
        accept: 'application/json',
        authorization: 'Bearer sk-live-abc123',
        'content-type': 'application/json',
        cookie: 'session=abc; other=def',
        'proxy-authorization': 'Basic dXNlcjpwYXNz',
        'set-cookie': 'sid=xyz; HttpOnly',
        'x-amz-security-token': 'st credentials',
        'x-api-key': 'ak-123',
        'x-csrf-token': 'csrf-1',
        'x-gitlab-token': 'glpat-abc',
        'x-hub-signature-256': 'sha256=deadbeef',
      })
    ).toStrictEqual({
      accept: 'application/json',
      authorization: '[REDACTED]',
      'content-type': 'application/json',
      cookie: '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
      'set-cookie': '[REDACTED]',
      'x-amz-security-token': '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-csrf-token': '[REDACTED]',
      'x-gitlab-token': '[REDACTED]',
      'x-hub-signature-256': '[REDACTED]',
    });
  });

  it('matches names case-insensitively and keeps the original casing', () => {
    const result = redactSensitiveHeaders({ Authorization: 'Bearer x', COOKIE: 'a=b' });

    expect(result).toStrictEqual({ Authorization: '[REDACTED]', COOKIE: '[REDACTED]' });
  });

  it('does not mutate the input record', () => {
    const input = { authorization: 'Bearer fixture-auth' };

    redactSensitiveHeaders(input);

    expect(input.authorization).toBe('Bearer fixture-auth');
  });

  it('passes undefined through so the renderer keeps its none marker', () => {
    const input: Record<string, string> | undefined = undefined;

    expect(redactSensitiveHeaders(input)).toBeUndefined();
  });
});

describe('body redaction', () => {
  it('replaces values of listed keys in JSON bodies and leaves other values', () => {
    expect(
      redactSensitiveBody(
        '{"username":"ada","password":"hunter2","api_key":"ak-1","nested":{"session":"s-1","note":"kept"}}'
      )
    ).toBe(
      JSON.stringify(
        {
          username: 'ada',
          password: '[REDACTED]',
          api_key: '[REDACTED]',
          nested: { session: '[REDACTED]', note: 'kept' },
        },
        null,
        2
      )
    );
  });

  it('matches keys case-insensitively and walks arrays', () => {
    expect(redactSensitiveBody('[{"Token":"t1"},{"ok":true}]')).toBe(
      JSON.stringify([{ Token: '[REDACTED]' }, { ok: true }], null, 2)
    );
  });

  it('returns undefined for non-object JSON scalars', () => {
    expect(redactSensitiveBody('"just a string"')).toBeUndefined();
    expect(redactSensitiveBody('42')).toBeUndefined();
  });

  it('replaces urlencoded listed-key values only', () => {
    expect(redactSensitiveBody('user=ada&password=hunter2&remember=true')).toBe(
      'user=ada&password=[REDACTED]&remember=true'
    );
  });

  it('matches urlencoded keys case-insensitively and by fragment', () => {
    expect(redactSensitiveBody('Password=x&authToken=y&z=1')).toBe(
      'Password=[REDACTED]&authToken=[REDACTED]&z=1'
    );
  });

  it('returns undefined for an equals-sign text that is not a form', () => {
    expect(redactSensitiveBody('1 + 1 = 2')).toBeUndefined();
  });

  it('replaces listed pairs when the body also carries non-pair segments', () => {
    expect(redactSensitiveBody('note=boundary=x&password=hunter2&flag')).toBe(
      'note=boundary=x&password=[REDACTED]&flag'
    );
  });

  it('replaces bracket-notation names by fragment match', () => {
    expect(redactSensitiveBody('user[password]=hunter2&remember=true')).toBe(
      'user[password]=[REDACTED]&remember=true'
    );
  });

  it('replaces multipart listed-field values and keeps other parts', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="username"',
      '',
      'ada',
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="username"',
        '',
        'ada',
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('locates the multipart value line past extra part headers', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      'Content-Type: application/json',
      '',
      'hunter2',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        'Content-Type: application/json',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces an empty multipart field value region', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      '',
      '',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces a multi-line multipart value region up to the delimiter', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      'more-of-the-value',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces a multipart value region spanning blank lines', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      '',
      'more-of-the-value',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces multipart values that begin with the delimiter prefix', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="password"',
      '',
      '--hunter2',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('returns undefined for free-text bodies', () => {
    expect(redactSensitiveBody('plain text body')).toBeUndefined();
  });
});

describe('base64 body redaction', () => {
  it('replaces listed keys in a base64 JSON body', () => {
    expect(redactSensitiveBase64Body(encode('{"ok":true,"password":"hunter2"}'))).toBe(
      JSON.stringify({ ok: true, password: '[REDACTED]' }, null, 2)
    );
  });

  it('replaces listed pairs in a base64 urlencoded body', () => {
    expect(redactSensitiveBase64Body(encode('user=ada&password=hunter2'))).toBe(
      'user=ada&password=[REDACTED]'
    );
  });

  it('decodes a wrapped payload', () => {
    const encoded = encode('{"token":"t-1"}');

    expect(redactSensitiveBase64Body(`${encoded.slice(0, 4)}\n${encoded.slice(4)}`)).toBe(
      JSON.stringify({ token: '[REDACTED]' }, null, 2)
    );
  });

  it('returns undefined when the decoded body has nothing to replace', () => {
    expect(redactSensitiveBase64Body(encode('{"ok":true}'))).toBeUndefined();
  });

  it('returns undefined for a binary payload', () => {
    expect(redactSensitiveBase64Body(encode('\u0089PNG\r\n\u001A\n'))).toBeUndefined();
  });

  it('returns undefined for text that is not a JSON or form body', () => {
    expect(redactSensitiveBase64Body(encode('plain text body'))).toBeUndefined();
  });
});
