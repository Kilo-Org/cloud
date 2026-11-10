/* eslint-disable max-lines -- one suite per replacement rule; the expected strings keep the input key order */
/* eslint-disable sort-keys -- the expected string preserves the input JSON key order */
import { describe, expect, it } from 'vitest';
import {
  redactSensitiveBase64Body,
  redactSensitiveBody,
  redactSensitiveHeaders,
  renderResponseBody,
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

  it('replaces every private-key field spelling in JSON bodies', () => {
    expect(
      redactSensitiveBody(
        '{"private_key":"a","privateKey":"b","private-key":"c","client_email":"svc@example.com"}'
      )
    ).toBe(
      JSON.stringify(
        {
          private_key: '[REDACTED]',
          privateKey: '[REDACTED]',
          'private-key': '[REDACTED]',
          client_email: 'svc@example.com',
        },
        null,
        2
      )
    );
  });

  it('replaces private-key material whatever its JSON key or array position', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody';

    expect(
      redactSensitiveBody(JSON.stringify({ items: [{ note: 'kept' }, pem], material: pem }))
    ).toBe(
      JSON.stringify({ items: [{ note: 'kept' }, '[REDACTED]'], material: '[REDACTED]' }, null, 2)
    );
  });

  it('replaces typed private-key labels and leaves public key material', () => {
    expect(
      redactSensitiveBody(
        JSON.stringify({
          ec: '-----BEGIN EC PRIVATE KEY-----',
          pgp: '-----BEGIN PGP PRIVATE KEY BLOCK-----',
          public: '-----BEGIN PUBLIC KEY-----',
          cert: '-----BEGIN CERTIFICATE-----',
        })
      )
    ).toBe(
      JSON.stringify(
        {
          ec: '[REDACTED]',
          pgp: '[REDACTED]',
          public: '-----BEGIN PUBLIC KEY-----',
          cert: '-----BEGIN CERTIFICATE-----',
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

  it('keeps the unstructured pass when a JSON body is nested beyond the walk', () => {
    // A body nested far past the walk's recursion budget still returns, so the
    // Renderer keeps the body instead of the tool call failing.
    let body = '"leaf"';
    for (let index = 0; index < 200_000; index += 1) {
      body = `{"a":${body}}`;
    }

    expect(redactSensitiveBody(body)).toBeUndefined();
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

  it('replaces a form value that holds private-key material under any name', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody';

    expect(redactSensitiveBody(`user=ada&material=${encodeURIComponent(pem)}&flag=true`)).toBe(
      'user=ada&material=[REDACTED]&flag=true'
    );
  });

  it('replaces a form value whose spaces are plus signs', () => {
    expect(redactSensitiveBody('material=-----BEGIN+OPENSSH+PRIVATE+KEY-----&flag=true')).toBe(
      'material=[REDACTED]&flag=true'
    );
  });

  it('leaves a form value with a malformed escape unmatched instead of throwing', () => {
    expect(redactSensitiveBody('material=%E0%A4%A&flag=true')).toBeUndefined();
  });

  it('replaces a multipart part value that holds private-key material under any name', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="username"',
      '',
      'ada',
      '--BOUNDARY',
      'Content-Disposition: form-data; name="material"',
      '',
      '-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody',
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
        'Content-Disposition: form-data; name="material"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('keeps a following part masked when an earlier part has no blank separator', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="username"',
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
        '--BOUNDARY',
        'Content-Disposition: form-data; name="password"',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces a pem block in a plain text body and keeps the surrounding text', () => {
    const block = '-----BEGIN EC PRIVATE KEY-----MIIEfixtureBody-----END EC PRIVATE KEY-----';

    expect(redactSensitiveBody(['downloaded material', block, 'trailer'].join('\n'))).toBe(
      ['downloaded material', '[REDACTED]', 'trailer'].join('\n')
    );
  });

  it('replaces a multipart part value when the name is unquoted', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name=password',
      '',
      'hunter2',
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data; name=password',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces a pem block in a file part that carries no name', () => {
    const block = '-----BEGIN EC PRIVATE KEY-----MIIEfixtureBody-----END EC PRIVATE KEY-----';
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data',
      'Content-Type: application/octet-stream',
      '',
      block,
      '--BOUNDARY--',
      '',
    ].join('\r\n');

    expect(redactSensitiveBody(body)).toBe(
      [
        '--BOUNDARY',
        'Content-Disposition: form-data',
        'Content-Type: application/octet-stream',
        '',
        '[REDACTED]',
        '--BOUNDARY--',
        '',
      ].join('\r\n')
    );
  });

  it('replaces a pgp armored block in a plain text body', () => {
    const block = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'MIIEfixtureBody',
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n');

    expect(redactSensitiveBody(['downloaded material', block, 'trailer'].join('\n'))).toBe(
      ['downloaded material', '[REDACTED]', 'trailer'].join('\n')
    );
  });

  it('replaces a block in a form segment that carries no separator', () => {
    expect(
      redactSensitiveBody(
        'password=hunter2&-----BEGIN RSA PRIVATE KEY-----MIIEfixtureBody&flag=true'
      )
    ).toBe('password=[REDACTED]&[REDACTED]');
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

  it('replaces private-key material in a base64 JSON body', () => {
    const body = encode(
      JSON.stringify({ material: '-----BEGIN ENCRYPTED PRIVATE KEY-----MIIEfixtureBody' })
    );

    expect(redactSensitiveBase64Body(body)).toBe(
      JSON.stringify({ material: '[REDACTED]' }, null, 2)
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

  it('returns undefined for a payload above the decode bound', () => {
    const payload = encode(`{"token":"${'a'.repeat(100_000)}"}`);

    expect(payload.length).toBeGreaterThan(100_000);
    expect(redactSensitiveBase64Body(payload)).toBeUndefined();
  });
});

describe('response body rendering', () => {
  it('replaces fields in a plain body', () => {
    expect(renderResponseBody('{"token":"t-1"}', false)).toBe(
      JSON.stringify({ token: '[REDACTED]' }, null, 2)
    );
  });

  it('keeps the marker for a body that decodes to nothing to replace', () => {
    expect(renderResponseBody(encode('{"ok":true}'), true)).toBe(
      `(base64) ${encode('{"ok":true}')}`
    );
  });

  it('replaces a pem block in a plain body', () => {
    const block = '-----BEGIN EC PRIVATE KEY-----MIIEfixtureBody-----END EC PRIVATE KEY-----';

    expect(renderResponseBody(['material', block].join('\n'), false)).toBe(
      ['material', '[REDACTED]'].join('\n')
    );
  });

  it('marks a decoded body that carries a pem block', () => {
    const block = '-----BEGIN EC PRIVATE KEY-----MIIEfixtureBody-----END EC PRIVATE KEY-----';

    expect(renderResponseBody(encode(block), true)).toBe('(base64, decoded) [REDACTED]');
  });

  it('marks a decoded body', () => {
    expect(renderResponseBody(encode('{"token":"t-1"}'), true)).toBe(
      `(base64, decoded) ${JSON.stringify({ token: '[REDACTED]' }, null, 2)}`
    );
  });
});
