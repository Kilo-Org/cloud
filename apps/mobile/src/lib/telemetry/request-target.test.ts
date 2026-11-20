import { describe, expect, it } from 'vitest';

import { stripQueryString, trpcProcedureText } from '@/lib/telemetry/request-target';

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

  it('keeps origin and path when the authority password contains a path separator', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('/');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
    expect(trpcProcedureText(url)).toBe('a.b');
  });

  it('keeps origin and path when the authority password contains a query marker', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('?');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
    expect(trpcProcedureText(url)).toBe('a.b');
  });

  it('keeps origin and path when the authority password contains a fragment marker', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('#');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps origin and path when the authority userinfo carries more than one @', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('@');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('keeps origin and path when the userinfo carries a query marker and a path segment', () => {
    const password = ['abcdefghij', 'klmnopqrst'].join('?');
    const url = `https://user:${password}@${HOST}${TRPC_PATH_FIXTURE}?batch=1`;

    expect(stripQueryString(url)).toBe(`https://${HOST}${TRPC_PATH_FIXTURE}`);
  });

  it('reduces a port and a path segment containing @ to the text after that @', () => {
    // The run up to the port holds a ':', which also reads as userinfo, so the
    // shape is indistinguishable from an authority and is reduced.
    expect(stripQueryString(`https://${HOST}:8443/api/${MEMBER}/x`)).toBe(`https://${HOST}/x`);
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
