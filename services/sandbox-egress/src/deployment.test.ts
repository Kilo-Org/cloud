import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createScmAuthority, type ScmAuthority } from './certificates.js';
import {
  establishProxyDeployment,
  type ProxyDeploymentStore,
  type ProxyMaterial,
} from './deployment.js';

const stackId = 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd';
const hostname = 'proxy.kilo.internal';
let authority: ScmAuthority;
let otherAuthority: ScmAuthority;
beforeAll(async () => {
  [authority, otherAuthority] = await Promise.all([createScmAuthority(), createScmAuthority()]);
});
function fixture() {
  let material: ProxyMaterial | undefined;
  let losePut = false;
  const publications: unknown[] = [];
  const store: ProxyDeploymentStore = {
    readPrivate: async () => structuredClone(material),
    async putPrivateOnce(candidate) {
      if (material) return 'exists';
      material = structuredClone(candidate);
      if (losePut) throw new Error('discarded successful response');
      return 'stored';
    },
    async publishPublic(value) {
      publications.push(value);
    },
    async publishIdentity(value) {
      publications.push(value);
    },
  };
  return {
    store,
    publications,
    material: () => material,
    losePut: () => {
      losePut = true;
    },
  };
}
describe('shared immutable deployment material', () => {
  it('makes two racing replicas publish the same conditional winner', async () => {
    const f = fixture();
    const createAuthority = vi
      .fn()
      .mockResolvedValueOnce(authority)
      .mockResolvedValueOnce(otherAuthority);
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        establishProxyDeployment({ stackId, hostname, store: f.store, createAuthority })
      )
    );
    expect(first).toEqual(second);
    expect(first).toEqual(f.material());
    expect(f.publications).toHaveLength(4);
    expect(createAuthority).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain('CA PRIVATE KEY');
    expect(Object.keys(first.tls).sort()).toEqual(['certificate', 'privateKey']);
  });
  it('recovers a lost private PUT response without changing its generated identity', async () => {
    const f = fixture();
    f.losePut();
    const material = await establishProxyDeployment({
      stackId,
      hostname,
      store: f.store,
      createAuthority: async () => authority,
    });
    expect(material).toEqual(f.material());
    const forbidden = vi.fn(async () => {
      throw new Error('Do not regenerate keys');
    });
    expect(
      await establishProxyDeployment({
        stackId,
        hostname,
        store: f.store,
        createAuthority: forbidden,
      })
    ).toEqual(material);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('refuses a foreign deployment without overwriting its public metadata', async () => {
    const f = fixture();
    await establishProxyDeployment({
      stackId,
      hostname,
      store: f.store,
      createAuthority: async () => authority,
    });
    f.publications.length = 0;
    await expect(
      establishProxyDeployment({ stackId, hostname: 'other.internal', store: f.store })
    ).rejects.toThrow('initialization failed');
    expect(f.publications).toHaveLength(0);
  });
  it('keeps serving admitted allocations until actual certificate expiry', async () => {
    const f = fixture();
    await establishProxyDeployment({
      stackId,
      hostname,
      store: f.store,
      createAuthority: async () => authority,
    });
    f.publications.length = 0;
    await expect(
      establishProxyDeployment({
        stackId,
        hostname,
        store: f.store,
        now: () => Date.parse(authority.expiresAt) - 1000,
      })
    ).resolves.toMatchObject({ deployment: { generation: f.material()?.deployment.generation } });
    f.publications.length = 0;
    await expect(
      establishProxyDeployment({
        stackId,
        hostname,
        store: f.store,
        now: () => Date.parse(authority.expiresAt),
      })
    ).rejects.toThrow('initialization failed');
    expect(f.publications).toHaveLength(0);
  });
});
