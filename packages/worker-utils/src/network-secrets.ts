import { z } from 'zod';
import { egressDomainSchema } from './egress-allowlist';
import {
  GITHUB_CAPABILITY_HOSTS,
  BITBUCKET_API_ORIGIN,
  BITBUCKET_GIT_ORIGIN,
} from './scm-capability-contract';

export const NETWORK_SECRET_LIMITS = { MAX_SECRETS: 20, MAX_HOSTS: 10 } as const;

export class NetworkSecretDestinationError extends Error {
  constructor() {
    super('Network secrets cannot target Kilo or managed SCM hosts');
    this.name = 'NetworkSecretDestinationError';
  }
}

const forbiddenHosts = new Set([
  ...GITHUB_CAPABILITY_HOSTS.filter(host => host !== 'npm.pkg.github.com'),
  new URL(BITBUCKET_API_ORIGIN).hostname,
  new URL(BITBUCKET_GIT_ORIGIN).hostname,
  'gitlab.com',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data.ec2.internal',
]);
const platformDomains = ['kilo.ai', 'kilocode.ai', 'kiloapps.io', 'kilosessions.ai'];
const privateSuffixes = ['localhost', 'local', 'internal', 'home.arpa'];

export const networkSecretHostSchema = egressDomainSchema.refine(
  host =>
    !forbiddenHosts.has(host) &&
    ![...platformDomains, ...privateSuffixes].some(
      domain => host === domain || host.endsWith(`.${domain}`)
    ),
  'Network secrets require a public domain outside Kilo and managed SCM hosts'
);

export const networkSecretStoredPolicySchema = z.object({
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(NETWORK_SECRET_LIMITS.MAX_HOSTS),
  locations: z.array(z.literal('header')).min(1).max(1).default(['header']),
});

export const networkSecretPolicySchema = networkSecretStoredPolicySchema.extend({
  allowedHosts: z
    .array(networkSecretHostSchema)
    .min(1)
    .max(NETWORK_SECRET_LIMITS.MAX_HOSTS)
    .transform(hosts => [...new Set(hosts)].sort()),
});

const scmEnvironmentKeys = new Set([
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GLAB_IS_OAUTH2',
  'GITLAB_HOST',
  'GITLAB_SUBFOLDER',
  'BITBUCKET_TOKEN',
]);
export const networkSecretKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine(
    key => !scmEnvironmentKeys.has(key),
    'This variable belongs to managed SCM. Use another name, such as NPM_TOKEN.'
  );

export const networkSecretEnvelopeSchema = z.object({
  encryptedData: z.string().min(1),
  encryptedDEK: z.string().min(1),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});

export const networkSecretsSchema = z
  .record(
    z
      .string()
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    networkSecretStoredPolicySchema.extend({ envelope: networkSecretEnvelopeSchema })
  )
  .refine(
    secrets => Object.keys(secrets).length <= NETWORK_SECRET_LIMITS.MAX_SECRETS,
    `Maximum ${NETWORK_SECRET_LIMITS.MAX_SECRETS} network secrets allowed`
  );

export const networkSecretInputSchema = networkSecretPolicySchema.extend({
  key: networkSecretKeySchema,
  value: z
    .string()
    .min(1)
    .max(8192)
    .refine(value => !/[\r\n\0]/.test(value), 'A network secret cannot contain a newline or NUL.'),
});

export const networkSecretChangeSchema = z.union([
  networkSecretInputSchema,
  z.object({ key: z.string().min(1).max(128), delete: z.literal(true) }),
]);

export type NetworkSecretPolicy = z.infer<typeof networkSecretPolicySchema>;
export type NetworkSecrets = z.infer<typeof networkSecretsSchema>;
export type NetworkSecretInput = z.infer<typeof networkSecretInputSchema>;
export type NetworkSecretChange = z.infer<typeof networkSecretChangeSchema>;

export function assertNetworkSecretDestinations(
  secrets: NetworkSecrets,
  excludedUrls: readonly string[]
): void {
  if (Object.keys(secrets).length === 0) return;
  const excluded = new Set(
    excludedUrls.map(url => new URL(url).hostname.toLowerCase().replace(/\.$/, ''))
  );
  for (const [key, secret] of Object.entries(secrets)) {
    networkSecretKeySchema.parse(key);
    const policy = networkSecretPolicySchema.parse(secret);
    if (policy.allowedHosts.some(host => excluded.has(host))) {
      throw new NetworkSecretDestinationError();
    }
  }
}
