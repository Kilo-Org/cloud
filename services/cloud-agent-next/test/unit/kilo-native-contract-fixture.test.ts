import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_DELIVERY_LIMITS,
  NATIVE_FACADE_FENCE_EVENT,
  NATIVE_FACADE_RESNAPSHOT_EVENT,
} from '../../src/kilo-facade/native-event-source.js';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/kilo-native-contract'
);
const facadeSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/kilo-facade/user-kilo-facade.ts'
);
const projectionSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/kilo-facade/public-sdk-projection.ts'
);

type Contract = {
  contractVersion: number;
  basePath: string;
  publicDirectory: string;
  headers: Record<string, string>;
  sse: { frames: string[]; resnapshot: { reasons: string[] } };
  routes: { method: string; path: string }[];
  errors: { code: string; status: number }[];
  limits: { nativeDelivery: Record<string, number> };
};

async function loadContract(): Promise<{
  contract: Contract;
  source: string;
  projection: string;
}> {
  const [raw, source, projection] = await Promise.all([
    readFile(path.join(fixtureDir, 'v1.json'), 'utf8'),
    readFile(facadeSource, 'utf8'),
    readFile(projectionSource, 'utf8'),
  ]);
  return { contract: JSON.parse(raw) as Contract, source, projection };
}

describe('kilo native contract fixture', () => {
  it('pins delivery limits to the implementation', async () => {
    const { contract } = await loadContract();
    expect(contract.limits.nativeDelivery).toEqual({ ...NATIVE_DELIVERY_LIMITS });
  });

  it('pins the fence and resnapshot frame names to the implementation', async () => {
    const { contract } = await loadContract();
    expect(contract.sse.frames).toContain(NATIVE_FACADE_FENCE_EVENT);
    expect(contract.sse.frames).toContain(NATIVE_FACADE_RESNAPSHOT_EVENT);
  });

  it('only lists error codes the facade can emit', async () => {
    const { contract, source } = await loadContract();
    expect(contract.errors.length).toBeGreaterThan(0);
    const missing = contract.errors
      .map(error => error.code)
      .filter(code => !source.includes(`'${code}'`));
    expect(missing).toEqual([]);
  });

  it('only lists route paths the facade serves', async () => {
    const { contract, source } = await loadContract();
    const unsupported = contract.routes.filter(
      route => !source.includes(`'${route.path}'`) && !source.includes(`"${route.path}"`)
    );
    // Paths with parameters are matched on their literal prefix instead.
    const missing = unsupported.filter(route => !route.path.includes('{'));
    expect(missing).toEqual([]);
    expect(contract.routes.some(route => route.path === '/session')).toBe(true);
    expect(contract.routes.some(route => route.path === '/event')).toBe(true);
  });

  it('describes the public directory and base path the facade uses', async () => {
    const { contract, projection } = await loadContract();
    expect(contract.basePath).toBe('/kilo');
    expect(contract.publicDirectory).toBe('/cloud-agent/sessions/{sessionID}');
    expect(projection).toContain('`/cloud-agent/sessions/${kiloSessionId}`');
  });

  it('keeps the version marker explicit and append-only', async () => {
    const { contract } = await loadContract();
    expect(contract.contractVersion).toBe(1);
    const files = await readFile(path.join(fixtureDir, 'README.md'), 'utf8');
    expect(files).toContain('Never edit a released version in place');
  });
});
