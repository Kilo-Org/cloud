import {
  KILO_API_RESOURCES,
  audienceOfResource,
  kiloApiProtectedResourceMetadata,
} from '@kilocode/uts-contracts';
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
  createFirstPartyRefreshToken,
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
    expect(
      audiencesOfResources(['urn:kilo:service:gateway', 'urn:kilo:service:gateway'], 'development')
    ).toEqual(['gateway']);
    expect(audiencesOfResources(['https://gateway.example.com'], 'development')).toBeNull();
    expect(
      audiencesOfResources(
        Array.from({ length: 9 }, (_, index) => `urn:kilo:service:s${index}`),
        'development'
      )
    ).toBeNull();
    expect(targetMismatch(['gateway:models.read'], ['gateway'])).toBe(false);
    expect(targetMismatch(['gateway:models.read'], ['gateway', 'mcp'])).toBe(true);
    expect(targetMismatch(['gateway:models.read', 'mcp:tools.call'], ['gateway'])).toBe(true);
  });

  it.each([
    ['production', 'https://app.kilo.ai', 'https://uts.kiloapps.io'],
    ['staging', 'https://staging-app.kilo.ai', 'https://uts-staging.kiloapps.io'],
    ['development', 'http://localhost:3000', 'http://localhost:8800'],
  ] as const)(
    'accept in %s only its own Kilo API origin and issuer, exactly',
    (environment, apiOrigin, issuer) => {
      expect(audienceOfResource(apiOrigin, environment)).toBe('kilo-api');
      expect(audienceOfResource(issuer, environment)).toBe('uts');
      expect(audienceOfResource('urn:kilo:service:kilo-api', environment)).toBe('kilo-api');
      for (const changed of [
        `${apiOrigin}/`,
        `${apiOrigin}/api/profile`,
        `${apiOrigin}?a=b`,
        `${apiOrigin}#x`,
        apiOrigin.toUpperCase(),
        `${issuer}/`,
        `${apiOrigin}.example.com`,
      ]) {
        expect(audienceOfResource(changed, environment)).toBeNull();
      }
      for (const [other, origin] of Object.entries(KILO_API_RESOURCES)) {
        if (other !== environment) expect(audienceOfResource(origin, environment)).toBeNull();
      }
    }
  );

  it('refuse loopback origins outside development, and other loopback forms in development', () => {
    for (const environment of ['production', 'staging'] as const) {
      expect(audienceOfResource('http://localhost:3000', environment)).toBeNull();
      expect(audienceOfResource('http://localhost:8800', environment)).toBeNull();
    }
    for (const loopback of [
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'https://localhost:3000',
    ]) {
      expect(audienceOfResource(loopback, 'development')).toBeNull();
    }
  });

  it('name the Kilo API origin in its RFC 9728 metadata', () => {
    expect(kiloApiProtectedResourceMetadata('staging')).toEqual({
      resource: 'https://staging-app.kilo.ai',
      authorization_servers: ['https://uts-staging.kiloapps.io'],
      scopes_supported: ['kilo-api:profile.read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Kilo API',
    });
    expect(kiloApiProtectedResourceMetadata('production').resource).toBe('https://app.kilo.ai');
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
    const token = createFirstPartyRefreshToken(grantId);
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
    expect(grantIdOfFirstPartyRefreshToken(createFirstPartyRefreshToken(grantId))).toBe(grantId);
  });

  it('compute the RFC 7636 S256 challenge (appendix B)', async () => {
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});
