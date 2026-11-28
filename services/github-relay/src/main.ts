import {
  STS_GITHUB_RELAY_MIGRATION_PROXY_READ,
  STS_ISSUERS,
  StsEnvironmentSchema,
} from '@kilocode/sts-contracts';
import { createVerifier, httpJwksSource } from '@kilocode/verify';
import { createRelay, type StsVerifier } from './relay';
import { createRelayServer } from './server';

/**
 * The relay process (deploy/github-relay.service). Its whole configuration is three environment
 * variables, none of them secret:
 * - `RELAY_STS_ENVIRONMENTS`: the STS environments whose tokens it accepts, comma-separated
 *   (default `staging,production`); the first answers a token of no known issuer.
 * - `RELAY_PUBLIC_URL`: its public origin, for the RFC 9728 challenge (default
 *   `https://github-relay.kiloapps.io`).
 * - `RELAY_PORT`: the loopback port Caddy proxies to (default 8080).
 */

const environments = (process.env.RELAY_STS_ENVIRONMENTS ?? 'staging,production')
  .split(',')
  .map(value => StsEnvironmentSchema.parse(value.trim()));
const publicUrl = process.env.RELAY_PUBLIC_URL ?? 'https://github-relay.kiloapps.io';
const port = Number(process.env.RELAY_PORT ?? '8080');

const verifiers: StsVerifier[] = environments.map(environment => ({
  issuer: STS_ISSUERS[environment],
  environment,
  verifier: createVerifier({
    audience: STS_GITHUB_RELAY_MIGRATION_PROXY_READ.audience,
    environment,
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
    sts: { issuer: STS_ISSUERS[environment], jwks: httpJwksSource(STS_ISSUERS[environment]) },
  }),
}));

const relay = createRelay({
  verifiers,
  fetch: (url, init) => fetch(url, init),
  log: line =>
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`),
  // The process outlives every request, so a background refresh only needs to stay referenced.
  waitUntil: promise => void promise.catch(() => undefined),
});

const server = createRelayServer(relay);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), listening: port, environments })}\n`
  );
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
