import { describe, expect, it } from 'vitest';
import { identifyClient, isLoopbackRedirect } from '../../src/oauth/clients';
import {
  audiencesOfResources,
  paramsOf,
  parseScopes,
  readForm,
  targetMismatch,
} from '../../src/oauth/params';
import { s256Challenge } from '../../src/oauth/pkce';
import {
  firstPartyRefreshToken,
  firstPartyRefreshTokenOfExchange,
  grantIdOfCode,
  grantIdOfFirstPartyRefreshToken,
  isRandomCredential,
  randomCredential,
} from '../../src/token/credentials';

describe('request parameters', () => {
  it('treat an empty value as absent and refuse a repeated parameter', () => {
    const params = paramsOf(new URLSearchParams('a=1&b=&c=1&c=2&r=x&r=y&r='));
    expect(params.one('a')).toEqual({ status: 'present', value: '1' });
    expect(params.one('b')).toEqual({ status: 'absent' });
    expect(params.one('missing')).toEqual({ status: 'absent' });
    expect(params.one('c')).toEqual({ status: 'repeated' });
    expect(params.all('r')).toEqual(['x', 'y']);
  });

  it('read only a form body of at most 16 KiB', async () => {
    const form = (body: string, contentType = 'application/x-www-form-urlencoded') =>
      readForm(
        new Request('http://localhost/token', {
          method: 'POST',
          body,
          headers: { 'Content-Type': contentType },
        })
      );
    expect(await form('grant_type=refresh_token')).toMatchObject({ status: 'ok' });
    expect(
      await form('grant_type=refresh_token', 'application/x-www-form-urlencoded; charset=UTF-8')
    ).toMatchObject({ status: 'ok' });
    expect(await form('{}', 'application/json')).toMatchObject({ status: 'invalid' });
    expect(await form(`a=${'x'.repeat(16 * 1024)}`)).toMatchObject({ status: 'invalid' });
  });

  it('cancel a body without a Content-Length once it passes 16 KiB, without reading the rest', async () => {
    const chunk = new TextEncoder().encode(`a=${'x'.repeat(4094)}`);
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: endless,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(request.headers.get('Content-Length')).toBeNull();
    expect(await readForm(request)).toEqual({
      status: 'invalid',
      description: 'the body is too large',
    });
    expect(cancelled).toBe(true);
    // Four 4 KiB chunks fit; the fifth passes the limit, and the stream is cancelled there.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it('count UTF-8 bytes, not characters, against the 16 KiB limit', async () => {
    // 6,000 characters of 3 UTF-8 bytes each: under 16 Ki characters, over 16 KiB.
    const body = new TextEncoder().encode(`a=${'€'.repeat(6000)}`);
    const request = new Request('http://localhost/token', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(await readForm(request)).toMatchObject({ status: 'invalid' });
  });

  it('parse a scope list of UTS scopes, each once, up to the limit', () => {
    expect(parseScopes('gateway:models.read mcp:tools.call', 8)).toEqual([
      'gateway:models.read',
      'mcp:tools.call',
    ]);
    expect(parseScopes('gateway:models.read gateway:models.read', 8)).toBeNull();
    expect(parseScopes('gateway:models.read  mcp:tools.call', 8)).toBeNull();
    expect(parseScopes('Gateway:models', 8)).toBeNull();
    expect(parseScopes('a:b c:d', 1)).toBeNull();
  });

  it('map resource indicators to audiences and find a mismatch with the scopes', () => {
    expect(audiencesOfResources(['urn:kilo:service:gateway', 'urn:kilo:service:gateway'])).toEqual([
      'gateway',
    ]);
    expect(audiencesOfResources(['https://gateway.example.com'])).toBeNull();
    expect(
      audiencesOfResources(Array.from({ length: 9 }, (_, index) => `urn:kilo:service:s${index}`))
    ).toBeNull();
    expect(targetMismatch(['gateway:models.read'], ['gateway'])).toBe(false);
    expect(targetMismatch(['gateway:models.read'], ['gateway', 'mcp'])).toBe(true);
    expect(targetMismatch(['gateway:models.read', 'mcp:tools.call'], ['gateway'])).toBe(true);
  });
});

describe('clients', () => {
  it('know the CLI as a desktop client and a metadata URL as a third-party client', () => {
    expect(identifyClient('kilo-cli')).toMatchObject({
      kind: 'first_party',
      client: { clientClass: 'desktop' },
    });
    expect(identifyClient('https://client.example.com/oauth/metadata.json')).toEqual({
      kind: 'third_party',
      clientId: 'https://client.example.com/oauth/metadata.json',
    });
    expect(identifyClient('https://client.example.com')).toEqual({ kind: 'unknown' });
    expect(identifyClient('http://client.example.com/metadata')).toEqual({ kind: 'unknown' });
    expect(identifyClient('__proto__')).toEqual({ kind: 'unknown' });
  });

  it('allow the CLI any loopback port on its callback path, and nothing else', () => {
    const identity = identifyClient('kilo-cli');
    if (identity.kind !== 'first_party') throw new Error('kilo-cli is first-party');
    const allowed = (uri: string) => isLoopbackRedirect(identity.client, uri);
    expect(allowed('http://127.0.0.1:4100/callback')).toBe(true);
    expect(allowed('http://[::1]:61000/callback')).toBe(true);
    expect(allowed('http://localhost:4100/callback')).toBe(false);
    expect(allowed('http://127.0.0.1/callback')).toBe(false);
    expect(allowed('https://127.0.0.1:4100/callback')).toBe(false);
    expect(allowed('http://127.0.0.1:4100/other')).toBe(false);
    expect(allowed('http://127.0.0.1:4100/callback?next=x')).toBe(false);
    expect(allowed('http://user@127.0.0.1:4100/callback')).toBe(false);
    expect(allowed('http://127.0.0.1:4100/a/../callback')).toBe(false);
    expect(allowed('not a url')).toBe(false);
  });
});

describe('credentials', () => {
  it('name the grant in a first-party refresh token and nowhere else', () => {
    const grantId = crypto.randomUUID();
    const token = firstPartyRefreshToken(grantId, randomCredential());
    expect(token).toMatch(/^kilo_rt_[A-Za-z0-9_-]{65}$/);
    expect(grantIdOfFirstPartyRefreshToken(token)).toBe(grantId);
    expect(grantIdOfFirstPartyRefreshToken(randomCredential())).toBeNull();
    expect(grantIdOfFirstPartyRefreshToken(`${token}x`)).toBeNull();
    // 22 base64url characters that are not the canonical encoding of 16 bytes.
    const noncanonical = `kilo_rt_${'_'.repeat(22)}${'A'.repeat(43)}`;
    expect(grantIdOfFirstPartyRefreshToken(noncanonical)).toBeNull();
  });

  it('make 32-byte random values that do not repeat', () => {
    const first = randomCredential();
    expect(isRandomCredential(first)).toBe(true);
    expect(first).not.toBe(randomCredential());
    expect(isRandomCredential(`${first}A`)).toBe(false);
  });

  it('derive one version 8 grant id per code', async () => {
    const code = randomCredential();
    const grantId = await grantIdOfCode(code);
    expect(grantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(await grantIdOfCode(code)).toBe(grantId);
    expect(await grantIdOfCode(randomCredential())).not.toBe(grantId);
    expect(
      grantIdOfFirstPartyRefreshToken(firstPartyRefreshToken(grantId, randomCredential()))
    ).toBe(grantId);
  });

  it('derive one first-party refresh token per code and verifier, naming the code grant', async () => {
    const code = randomCredential();
    const verifier = randomCredential();
    const grantId = await grantIdOfCode(code);
    const token = await firstPartyRefreshTokenOfExchange(grantId, code, verifier);
    expect(token).toMatch(/^kilo_rt_[A-Za-z0-9_-]{65}$/);
    expect(grantIdOfFirstPartyRefreshToken(token)).toBe(grantId);
    expect(await firstPartyRefreshTokenOfExchange(grantId, code, verifier)).toBe(token);
    expect(await firstPartyRefreshTokenOfExchange(grantId, code, randomCredential())).not.toBe(
      token
    );
    const otherCode = randomCredential();
    expect(
      (await firstPartyRefreshTokenOfExchange(grantId, otherCode, verifier)).slice(-43)
    ).not.toBe(token.slice(-43));
  });

  it('compute the RFC 7636 S256 challenge (appendix B)', async () => {
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});
