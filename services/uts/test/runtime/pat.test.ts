import { createExecutionContext } from 'cloudflare:test';
import {
  PatProbeResponseSchema,
  UtsPatLookupResultSchema,
  type PatLookupBinding,
  type UtsPatLookupResult,
} from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { type Env, MAX_PAT_LOOKUPS_IN_FLIGHT, patLookupsInFlight, readConfig } from '../../src/env';
import { handleRequest } from '../../src/http';
import { LOOKUPS_PER_SECOND_PER_ADDRESS } from '../../src/pat/address-limit';
import { PatLookup } from '../../src/pat/entrypoint';
import * as deployed from '../../src/index';
import * as development from '../../src/dev-index';
import { createSecret, hexOfHash, secretHash } from '../../src/pat/format';
import { type PatRow, lookupPatHash } from '../../src/pat/lookup';
import { type PatProbeDeps, handlePatProbe } from '../../src/pat/probe';
import { storeFailure } from './oauth-support';
import { config, env } from './test-env';

/** The PAT lookup, its entrypoint, and the probe route that UTS verifies itself. */

const row = (overrides: Partial<PatRow> = {}): PatRow => ({
  patId: crypto.randomUUID(),
  accountId: 'oauth/pat-runtime',
  audience: 'uts',
  scope: 'uts:probe.read',
  orgId: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  ...overrides,
});

async function hashOf(pat: string): Promise<string> {
  return hexOfHash(await secretHash(pat));
}

describe('the PAT lookup', () => {
  it('answers a live PAT with its record, and not_found for an unknown or malformed hash', async () => {
    const found = row();
    const seen: Uint8Array[] = [];
    const pat = createSecret('pat');
    const result = await lookupPatHash(
      await hashOf(pat),
      async hash => {
        seen.push(hash);
        return found;
      },
      MAX_PAT_LOOKUPS_IN_FLIGHT
    );
    expect(result).toEqual({
      status: 'found',
      record: {
        patId: found.patId,
        subject: found.accountId,
        audience: 'uts',
        scope: 'uts:probe.read',
        org: null,
        expiresAt: Math.floor(found.expiresAt.getTime() / 1000),
      },
    });
    expect(seen).toEqual([await secretHash(pat)]);
    expect(
      await lookupPatHash(await hashOf(pat), async () => null, MAX_PAT_LOOKUPS_IN_FLIGHT)
    ).toEqual({
      status: 'not_found',
    });
    for (const malformed of [
      '',
      'ABC',
      'g'.repeat(64),
      await hashOf(pat).then(h => h.toUpperCase()),
    ]) {
      expect(await lookupPatHash(malformed, async () => found, MAX_PAT_LOOKUPS_IN_FLIGHT)).toEqual({
        status: 'not_found',
      });
    }
  });

  it('answers unavailable when the identity store fails, whatever the failure', async () => {
    for (const failure of ['retryable', 'permanent'] as const) {
      const result = await lookupPatHash(
        await hashOf(createSecret('pat')),
        async () => {
          throw storeFailure(failure);
        },
        MAX_PAT_LOOKUPS_IN_FLIGHT
      );
      expect(result).toEqual({ status: 'unavailable', retryAfterSeconds: 2 });
    }
  });

  it.each([
    ['production', '32', 96],
    ['staging', '12', 36],
    ['development', '34', 100],
  ] as const)(
    'derives the cap in %s from PAT_LOOKUP_CONNECTIONS %s: %i lookups at once, then rate_limited',
    async (environment, connections, cap) => {
      const target: Env = {
        ...env,
        UTS_ENVIRONMENT: environment,
        DO_JURISDICTION: environment === 'development' ? 'none' : 'eu',
        PAT_LOOKUP_CONNECTIONS: connections,
      };
      expect(patLookupsInFlight(target)).toBe(cap);
      const limiter = { inFlight: 0 };
      const { promise: gate, resolve } = Promise.withResolvers<void>();
      const hash = await hashOf(createSecret('pat'));
      const held = Array.from({ length: cap }, () =>
        lookupPatHash(
          hash,
          async () => {
            await gate;
            return row();
          },
          patLookupsInFlight(target),
          limiter
        )
      );
      expect(limiter.inFlight).toBe(cap);
      expect(
        await lookupPatHash(hash, async () => row(), patLookupsInFlight(target), limiter)
      ).toEqual({ status: 'rate_limited', retryAfterSeconds: 1 });
      resolve();
      expect((await Promise.all(held)).every(result => result.status === 'found')).toBe(true);
      expect(limiter.inFlight).toBe(0);
    }
  );

  it('refuses to start staging or production without a valid PAT_LOOKUP_CONNECTIONS', () => {
    for (const environment of ['production', 'staging'] as const) {
      const missing: Env = {
        ...env,
        UTS_ENVIRONMENT: environment,
        DO_JURISDICTION: 'eu',
        PAT_LOOKUP_CONNECTIONS: undefined,
      };
      expect(() => readConfig(missing)).toThrow(/PAT_LOOKUP_CONNECTIONS/);
      for (const invalid of ['0', '-3', '12.5', 'twelve', '']) {
        expect(() => readConfig({ ...missing, PAT_LOOKUP_CONNECTIONS: invalid })).toThrow();
      }
    }
    const development: Env = { ...env, PAT_LOOKUP_CONNECTIONS: undefined };
    expect(readConfig(development).environment).toBe('development');
    expect(patLookupsInFlight(development)).toBe(MAX_PAT_LOOKUPS_IN_FLIGHT);
  });
});

/** One `lookup()` call through `binding`, validated and then disposed as a verifier does. */
async function lookupThrough(binding: PatLookupBinding, hash: string): Promise<UtsPatLookupResult> {
  const result = await binding.lookup(hash);
  const parsed = UtsPatLookupResultSchema.parse(result);
  if (typeof result === 'object' && result !== null && Symbol.dispose in result) {
    const dispose = result[Symbol.dispose];
    if (typeof dispose === 'function') dispose.call(result);
  }
  return parsed;
}

describe('the PatLookup entrypoint', () => {
  it('is a named WorkerEntrypoint export of the deployed and the development entry', () => {
    expect(deployed.PatLookup).toBe(PatLookup);
    expect(development.PatLookup).toBe(PatLookup);
  });

  it('runs the lookup for a listed caller; an unreachable store answers unavailable', async () => {
    // The test config's PAT config points at a port nothing listens on.
    expect(await lookupThrough(env.VERIFIER_PAT_LOOKUP, await hashOf(createSecret('pat')))).toEqual(
      {
        status: 'unavailable',
        retryAfterSeconds: 2,
      }
    );
  });

  it('refuses a caller that is not listed, or a binding without props, before any lookup', async () => {
    for (const binding of [env.OTHER_PAT_LOOKUP, env.PROPLESS_PAT_LOOKUP]) {
      expect(await lookupThrough(binding, await hashOf(createSecret('pat')))).toEqual({
        status: 'unavailable',
        retryAfterSeconds: 60,
      });
    }
  });
});

function probeRequest(headers: Record<string, string>): Request {
  return new Request(`${config.endpoints.issuer}/probe/pat`, { headers });
}

function probeDeps(lookup: PatProbeDeps['lookup']): PatProbeDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    config,
    lookup: async hash => {
      lookups.push(hash);
      return await lookup(hash);
    },
    windows: new Map(),
    now: () => 1_000_000,
    lookups,
  };
}

const ADDRESS = { 'CF-Connecting-IP': '192.0.2.7' };

describe('the PAT probe route', () => {
  it('answers whose PAT it is for a live probe PAT', async () => {
    const pat = createSecret('pat');
    const found = row();
    const deps = probeDeps(async () =>
      lookupPatHash(await hashOf(pat), async () => found, MAX_PAT_LOOKUPS_IN_FLIGHT)
    );
    const response = await handlePatProbe(
      probeRequest({ Authorization: `Bearer ${pat}`, ...ADDRESS }),
      deps
    );
    expect(response.status).toBe(200);
    expect(PatProbeResponseSchema.parse(await response.json())).toEqual({
      sub: found.accountId,
      pat_id: found.patId,
      audience: 'uts',
      scope: 'uts:probe.read',
      org: null,
    });
    expect(deps.lookups).toEqual([await hashOf(pat)]);
  });

  it('answers 401 for a revoked or unknown PAT, and 403 for a PAT of another scope', async () => {
    const pat = createSecret('pat');
    const gone = await handlePatProbe(
      probeRequest({ Authorization: `Bearer ${pat}`, ...ADDRESS }),
      probeDeps(async () => ({ status: 'not_found' }))
    );
    expect(gone.status).toBe(401);
    expect(gone.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    const other = await handlePatProbe(
      probeRequest({ Authorization: `Bearer ${pat}`, ...ADDRESS }),
      probeDeps(async hash =>
        lookupPatHash(
          hash,
          async () => row({ audience: 'gateway', scope: 'gateway:models.read' }),
          MAX_PAT_LOOKUPS_IN_FLIGHT
        )
      )
    );
    expect(other.status).toBe(403);
  });

  it('refuses a malformed PAT or another credential offline, with no lookup', async () => {
    const pat = createSecret('pat');
    const flipped = `${pat.slice(0, 20)}${pat[20] === 'A' ? 'B' : 'A'}${pat.slice(21)}`;
    for (const value of [flipped, createSecret('bot_key'), 'eyJhbGciOi.x.y', `${pat}x`]) {
      const deps = probeDeps(async () => ({ status: 'not_found' }));
      const response = await handlePatProbe(
        probeRequest({ Authorization: `Bearer ${value}`, ...ADDRESS }),
        deps
      );
      expect(response.status).toBe(401);
      expect(deps.lookups).toEqual([]);
    }
    const missing = await handlePatProbe(
      probeRequest(ADDRESS),
      probeDeps(async () => ({ status: 'not_found' }))
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('needs a client address and allows 20 lookups per second from one', async () => {
    const pat = createSecret('pat');
    const deps = probeDeps(async () => ({ status: 'not_found' }));
    expect(
      (await handlePatProbe(probeRequest({ Authorization: `Bearer ${pat}` }), deps)).status
    ).toBe(400);
    const statuses: number[] = [];
    for (let index = 0; index <= LOOKUPS_PER_SECOND_PER_ADDRESS; index += 1) {
      statuses.push(
        (await handlePatProbe(probeRequest({ Authorization: `Bearer ${pat}`, ...ADDRESS }), deps))
          .status
      );
    }
    expect(statuses.filter(status => status === 401)).toHaveLength(LOOKUPS_PER_SECOND_PER_ADDRESS);
    expect(statuses.at(-1)).toBe(429);
    const other = await handlePatProbe(
      probeRequest({ Authorization: `Bearer ${pat}`, 'CF-Connecting-IP': '192.0.2.8' }),
      deps
    );
    expect(other.status).toBe(401);
  });

  it('answers 503 with the retry time when the lookup cannot answer', async () => {
    for (const result of [
      { status: 'unavailable', retryAfterSeconds: 2 },
      { status: 'rate_limited', retryAfterSeconds: 1 },
    ] as const) {
      const response = await handlePatProbe(
        probeRequest({ Authorization: `Bearer ${createSecret('pat')}`, ...ADDRESS }),
        probeDeps(async () => result)
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe(String(result.retryAfterSeconds));
    }
  });

  it('is served with the protected-resource metadata through the mint Worker', async () => {
    const ctx = createExecutionContext();
    const metadata = await handleRequest(
      new Request(`${config.endpoints.issuer}/.well-known/oauth-protected-resource`),
      env,
      ctx
    );
    expect(await metadata.json()).toEqual({
      resource: config.endpoints.issuer,
      authorization_servers: [config.endpoints.issuer],
      scopes_supported: ['uts:pats.manage', 'uts:bot-keys.manage', 'uts:probe.read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Kilo account API',
    });
    const probe = await handleRequest(probeRequest({}), env, ctx);
    expect(probe.status).toBe(401);
  });
});
