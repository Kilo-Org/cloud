/**
 * A stand-in STS for the local end-to-end runs of the HTTPS feed: one synthetic Ed25519 key, its
 * key set served on a loopback port at `/.well-known/jwks.json`, and service tokens in the STS
 * profile (`@kilocode/sts-contracts`) for audience `uts-feed`. The feed Worker runs with
 * `--var STS_URL:<issuer>`, so it verifies these tokens with `@kilocode/verify` exactly as it
 * verifies STS tokens when deployed. Nothing here is a real key or token.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UTS_FEED_AUDIENCE, UTS_FEED_READ_SCOPE, type FeedFetch } from '@kilocode/uts-contracts';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export type FakeSts = {
  /** The `iss` of its tokens and the `STS_URL` the feed Worker runs with. */
  issuer: string;
  /** How many times its key set was fetched. */
  keySetFetches(): number;
  token(options?: {
    workload?: string;
    audience?: string;
    scope?: string;
    environment?: string;
    expired?: boolean;
    foreignKey?: boolean;
  }): Promise<string>;
  /** A feed fetcher that sends a fresh token of `workload` on every request. */
  fetcher(workload: string): FeedFetch;
  close(): Promise<void>;
};

const KID = 'sts-e2e-0';

export async function startFakeSts(port: number): Promise<FakeSts> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: 'EdDSA', use: 'sig' };
  let fetches = 0;
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      fetches += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listening port');
  const issuer = `http://127.0.0.1:${address.port}`;

  const token: FakeSts['token'] = async (options = {}) => {
    const workload = options.workload ?? 'web';
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = options.expired ? now - 300 : now;
    const key = options.foreignKey
      ? (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey
      : privateKey;
    return await new SignJWT({
      client_id: workload,
      req: workload,
      scope: options.scope ?? UTS_FEED_READ_SCOPE,
      env: options.environment ?? 'development',
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
      .setIssuer(issuer)
      .setAudience(options.audience ?? UTS_FEED_AUDIENCE)
      .setSubject(`service:${workload}`)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(options.expired ? now - 120 : issuedAt + 300)
      .sign(key);
  };

  return {
    issuer,
    keySetFetches: () => fetches,
    token,
    fetcher: workload => async (url, init) =>
      await fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${await token({ workload })}` },
      }),
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
