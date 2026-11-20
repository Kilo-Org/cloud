import { describe, expect, it } from 'vitest';

import { stripQueryString, TRPC_PATH, trpcProcedureText } from '@/lib/telemetry/request-target';

// Assembled from parts so the fixture reads as a plain URL value.
const USERINFO = ['user', 'abcdefghijklmnopqrst'].join(':');

const HOST = 'example.com';
const TRPC_PATH_FIXTURE = '/api/trpc/a.b';
const MEMBER = ['member', HOST].join('@');

describe('stripQueryString', () => {
  it('drops the query string', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b?batch=1&input=secret')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('leaves a query-free URL unchanged', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('keeps origin and path for a fragment suffix', () => {
    expect(stripQueryString('https://example.com/oauth/callback#abcdefghijklmnopqrst')).toBe(
      'https://example.com/oauth/callback'
    );
  });

  it('keeps origin and path when the authority carries userinfo', () => {
    expect(stripQueryString(`https://${USERINFO}@example.com/api/trpc/a.b`)).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('keeps origin and path for a multi-part authority secret', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('/');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
    expect(trpcProcedureText(url)).toBe('a.b');
  });

  it('keeps origin and path for an authority secret holding a delimiter', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('?');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
    expect(trpcProcedureText(url)).toBe('a.b');
  });

  it('keeps origin and path for an authority secret holding punctuation', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('#');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps origin and path for userinfo holding a second at-sign', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('@');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps origin and path for a delimited authority secret and a query', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('?');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}?batch=1`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps a host with a port unchanged when its path carries an at-sign', () => {
    expect(stripQueryString(`https://${HOST}:8443/api/${MEMBER}/x`)).toBe(
      `https://${HOST}:8443/api/${MEMBER}/x`
    );
  });

  it('keeps a host with a port unchanged when its first path segment carries an at-sign', () => {
    const segment = ['a', HOST].join('@');
    expect(stripQueryString(`https://${HOST}:8443/${segment}/c`)).toBe(
      `https://${HOST}:8443/${segment}/c`
    );
  });

  it('reduces userinfo that carries a port and keeps the rest of the target', () => {
    const userinfo = ['user', 'pw'].join(':');
    expect(stripQueryString(`https://${userinfo}@${HOST}:8443/api/x?y=1`)).toBe(
      `https://${HOST}:8443/api/x`
    );
  });

  it('keeps an IPv4 authority with a port and drops a query value carrying an at-sign', () => {
    const procedure = ['x', 'y'].join('.');
    const url = `https://127.0.0.1:8080${TRPC_PATH}${procedure}?x=${MEMBER}`;

    expect(stripQueryString(url)).toBe(`https://127.0.0.1:8080${TRPC_PATH}${procedure}`);
  });

  it('keeps origin and path for a numeric-leading run that spans several separators', () => {
    const segment = ['12345', 'abcdefghij', 'klmnopqrst'].join('/');
    const url = `https://user:${segment}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps origin and path when a numeric-looking run precedes the at-sign segment', () => {
    const segment = ['12345', 'abc'].join('/');
    const url = `https://user:${segment}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps a loopback host with a port and drops a query value carrying an at-sign', () => {
    const procedure = ['x', 'y'].join('.');
    const url = `http://localhost:3000${TRPC_PATH}${procedure}?email=${MEMBER}`;

    expect(stripQueryString(url)).toBe(`http://localhost:3000${TRPC_PATH}${procedure}`);
    expect(trpcProcedureText(url)).toBe(procedure);
  });

  it('keeps a bracketed IPv6 authority and drops a query value carrying an at-sign', () => {
    const literal = `[${['2001', 'db8', '', '1'].join(':')}]`;
    const url = `https://${literal}${TRPC_PATH_FIXTURE}?x=${MEMBER}`;

    expect(stripQueryString(url)).toBe(`https://${literal}${TRPC_PATH_FIXTURE}`);
  });

  it('drops the query string of a bare host when its value contains @', () => {
    expect(stripQueryString(`https://host${TRPC_PATH_FIXTURE}?user=${MEMBER}`)).toBe(
      `https://host${TRPC_PATH_FIXTURE}`
    );
  });

  it('leaves a host with @ in its path unchanged', () => {
    expect(stripQueryString(`https://${HOST}/api/${MEMBER}/x`)).toBe(
      `https://${HOST}/api/${MEMBER}/x`
    );
  });

  it('drops the query string when its value contains @', () => {
    expect(stripQueryString(`https://${HOST}${TRPC_PATH_FIXTURE}?user=${MEMBER}`)).toBe(
      `https://${HOST}${TRPC_PATH_FIXTURE}`
    );
  });

  it('leaves a bracketed IPv6 authority unchanged', () => {
    expect(
      stripQueryString(`https://[${['2001', 'db8', '', '1'].join(':')}]${TRPC_PATH_FIXTURE}`)
    ).toBe(`https://[${['2001', 'db8', '', '1'].join(':')}]${TRPC_PATH_FIXTURE}`);
  });

  it('leaves a scheme-less string unchanged except for its query and fragment', () => {
    expect(stripQueryString(`no-scheme/${MEMBER}/x?detail=1#top`)).toBe(`no-scheme/${MEMBER}/x`);
  });
});
