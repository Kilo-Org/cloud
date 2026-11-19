import { createPublicKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import {
  awsEgressPublicDeploymentSchema,
  awsEgressSharedIdentitySchema,
} from '@kilocode/worker-utils/aws-egress';
import { AWS_MICROVM_MAXIMUM_DURATION_SECONDS } from '@kilocode/worker-utils/aws-byoc';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import { createScmAuthority, type ScmAuthority } from './certificates.js';

const materialSchema = z
  .object({
    deployment: awsEgressPublicDeploymentSchema,
    identity: awsEgressSharedIdentitySchema,
    tls: z
      .object({
        certificate: z.string().min(128).max(16_384),
        privateKey: z.string().min(128).max(16_384),
      })
      .strict(),
  })
  .strict();
export type ProxyMaterial = z.infer<typeof materialSchema>;
export type ProxyDeploymentStore = {
  readPrivate(): Promise<unknown>;
  putPrivateOnce(material: ProxyMaterial): Promise<'stored' | 'exists'>;
  publishPublic(material: ProxyMaterial['deployment']): Promise<void>;
  publishIdentity(material: ProxyMaterial['identity']): Promise<void>;
};

/** All replicas use the first conditional write. A lost PUT response is reconciled by reading that same object. */
export async function establishProxyDeployment(input: {
  stackId: string;
  hostname: string;
  store: ProxyDeploymentStore;
  createAuthority?: () => Promise<ScmAuthority>;
  now?: () => number;
}): Promise<ProxyMaterial> {
  const now = input.now ?? Date.now;
  async function validated(raw: unknown, validAfter: number): Promise<ProxyMaterial> {
    const material = materialSchema.parse(raw);
    const { deployment, identity, tls } = material;
    const ca = new X509Certificate(deployment.caCertificate);
    const leaf = new X509Certificate(tls.certificate);
    const expiry = Math.min(Date.parse(ca.validTo), Date.parse(leaf.validTo));
    if (
      deployment.stackId !== input.stackId ||
      identity.stackId !== input.stackId ||
      deployment.hostname !== input.hostname ||
      deployment.generation !== identity.generation ||
      deployment.protocolVersion !== identity.protocolVersion ||
      !ca.ca ||
      leaf.ca ||
      !leaf.verify(ca.publicKey) ||
      STANDARD_SCM_HOSTS.some(host => leaf.checkHost(host) !== host) ||
      !createPublicKey(tls.privateKey)
        .export({ type: 'spki', format: 'der' })
        .equals(leaf.publicKey.export({ type: 'spki', format: 'der' })) ||
      deployment.caFingerprint !== (await sha256Hex(deployment.caCertificate)) ||
      Date.parse(deployment.expiresAt) !== expiry ||
      expiry <= validAfter
    )
      throw new Error('Invalid AWS proxy material');
    return material;
  }
  try {
    let raw = await input.store.readPrivate();
    if (raw === undefined) {
      const authority = await (input.createAuthority ?? createScmAuthority)();
      const common = {
        stackId: input.stackId,
        generation: randomUUID(),
        protocolVersion: 1 as const,
      };
      const candidate = await validated(
        {
          deployment: {
            ...common,
            hostname: input.hostname,
            port: 3128,
            caCertificate: authority.caCertificate,
            caFingerprint: await sha256Hex(authority.caCertificate),
            expiresAt: authority.expiresAt,
          },
          identity: { ...common, secret: randomBytes(32).toString('hex') },
          tls: { certificate: authority.certificate, privateKey: authority.privateKey },
        },
        now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000
      );
      try {
        raw =
          (await input.store.putPrivateOnce(candidate)) === 'stored'
            ? candidate
            : await input.store.readPrivate();
      } catch {
        raw = await input.store.readPrivate();
      }
    }
    const material = await validated(raw, now());
    await Promise.all([
      input.store.publishPublic(material.deployment),
      input.store.publishIdentity(material.identity),
    ]);
    return material;
  } catch {
    throw new Error('AWS proxy deployment initialization failed');
  }
}
