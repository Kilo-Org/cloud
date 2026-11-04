import { Buffer } from 'node:buffer';
import {
  isControlPlaneCredential,
  parseControlPlaneCredential,
} from '../sandbox-control/managed-credential.js';
import {
  ACCEPTED_CAPABILITY_PREFIXES,
  CAPABILITY_FAMILY_PATTERN_SOURCE,
} from '@kilocode/worker-utils/scm-capability-contract';

const CAPABILITY_FAMILY = new RegExp(`^${CAPABILITY_FAMILY_PATTERN_SOURCE}`);

export type ResolvedScmCapability = {
  provider: 'github' | 'gitlab' | 'bitbucket';
  capability: string;
};
type AuthorizationExtraction =
  | { type: 'none' }
  | { type: 'capability'; value: ResolvedScmCapability }
  | { type: 'unsupported_capability' };

const NO_AUTHORIZATION_CAPABILITY = { type: 'none' } satisfies AuthorizationExtraction;

type AuthorizationClass =
  | 'github-managed'
  | 'gitlab-managed'
  | 'bitbucket-managed'
  | 'unsupported-managed'
  | 'mixed'
  | 'unmanaged'
  | 'none';

function classifyCapability(capability: string): AuthorizationExtraction {
  if (isControlPlaneCredential(capability)) {
    const parsed = parseControlPlaneCredential(capability);
    return parsed && parsed.purpose !== 'kilo'
      ? { type: 'capability', value: { provider: parsed.purpose, capability } }
      : { type: 'unsupported_capability' };
  }
  for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
    if (ACCEPTED_CAPABILITY_PREFIXES[provider].some(prefix => capability.startsWith(prefix))) {
      return { type: 'capability', value: { provider, capability } };
    }
  }
  return CAPABILITY_FAMILY.test(capability)
    ? { type: 'unsupported_capability' }
    : NO_AUTHORIZATION_CAPABILITY;
}

export function parseGitAuthorization(authorization: string | null): {
  prefix: string;
  username: string;
  password: string;
  canonical: boolean;
} | null {
  if (!authorization) return null;
  const match = /^(Basic[ \t]+)(.+)$/i.exec(authorization);
  if (!match) return null;
  const encodedCredential = match[2];
  const decodedCredential = Buffer.from(encodedCredential, 'base64');
  const credential = decodedCredential.toString('utf8');
  const separator = credential.indexOf(':');
  return {
    prefix: match[1],
    username: separator === -1 ? credential : credential.slice(0, separator),
    password: separator === -1 ? '' : credential.slice(separator + 1),
    canonical:
      separator !== -1 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(encodedCredential) &&
      decodedCredential.toString('base64') === encodedCredential,
  };
}

export function extractGitCapability(authorization: string | null): AuthorizationExtraction {
  const git = parseGitAuthorization(authorization);
  if (!git) return NO_AUTHORIZATION_CAPABILITY;
  if (
    isControlPlaneCredential(git.username) ||
    (!git.canonical && isControlPlaneCredential(git.password))
  ) {
    return { type: 'unsupported_capability' };
  }
  if (!git.canonical) return NO_AUTHORIZATION_CAPABILITY;
  const extraction = classifyCapability(git.password);
  if (extraction.type !== 'capability') return extraction;
  if (git.username === 'x-access-token' && extraction.value.provider === 'github') {
    return extraction;
  }
  if (git.username === 'oauth2' && extraction.value.provider === 'gitlab') {
    return extraction;
  }
  if (git.username === 'x-token-auth' && extraction.value.provider === 'bitbucket') {
    return extraction;
  }
  return { type: 'unsupported_capability' };
}

export function extractApiCapability(authorization: string | null): AuthorizationExtraction {
  if (!authorization) return NO_AUTHORIZATION_CAPABILITY;
  const match = /^(token|Bearer)[ \t]+(.+)$/i.exec(authorization);
  if (!match?.[2]) return NO_AUTHORIZATION_CAPABILITY;
  const extraction = classifyCapability(match[2]);
  if (extraction.type !== 'capability') return extraction;
  if (extraction.value.provider === 'gitlab' && match[1]?.toLowerCase() !== 'bearer') {
    return { type: 'unsupported_capability' };
  }
  return extraction;
}

export function extractGitLabPrivateTokenCapability(
  privateToken: string | null
): AuthorizationExtraction {
  if (!privateToken) return NO_AUTHORIZATION_CAPABILITY;
  const extraction = classifyCapability(privateToken.trim());
  if (extraction.type !== 'capability') return extraction;
  return extraction.value.provider === 'gitlab' ? extraction : { type: 'unsupported_capability' };
}

export function getAuthorizationClass(
  extractions: AuthorizationExtraction[],
  hasUnmanagedAuthorization: boolean
): AuthorizationClass {
  if (extractions.some(extraction => extraction.type === 'unsupported_capability')) {
    return 'unsupported-managed';
  }
  const capabilities = extractions.flatMap(extraction =>
    extraction.type === 'capability' ? [extraction.value] : []
  );
  const capability = capabilities[0];
  if (!capability) return hasUnmanagedAuthorization ? 'unmanaged' : 'none';
  if (
    hasUnmanagedAuthorization ||
    capabilities.some(
      candidate =>
        candidate.provider !== capability.provider || candidate.capability !== capability.capability
    )
  ) {
    return 'mixed';
  }
  return capability.provider === 'github'
    ? 'github-managed'
    : capability.provider === 'bitbucket'
      ? 'bitbucket-managed'
      : 'gitlab-managed';
}

export type ScmAuthorization =
  | { type: 'denied' }
  | { type: 'unmanaged' }
  | { type: 'managed'; value: ResolvedScmCapability };

const RAW_CREDENTIAL_FAMILY = new RegExp(`(?:kcp\\d+\\.|${CAPABILITY_FAMILY_PATTERN_SOURCE})`);

/** Classify every supported carrier together before any forwarding or alias resolution. */
export function classifyScmAuthorization(input: {
  authorization?: string | null;
  privateToken?: string | null;
}): ScmAuthorization & { authorizationClass: AuthorizationClass } {
  const authorization = input.authorization ?? null;
  const privateToken = input.privateToken ?? null;
  const git = extractGitCapability(authorization);
  const api = extractApiCapability(authorization);
  const privateExtraction = extractGitLabPrivateTokenCapability(privateToken);
  const extractions = [git, api, privateExtraction];
  const hasUnmanaged =
    (authorization !== null && git.type === 'none' && api.type === 'none') ||
    (privateToken !== null && privateExtraction.type === 'none');
  const classification = getAuthorizationClass(extractions, hasUnmanaged);
  if (classification === 'mixed' || classification === 'unsupported-managed')
    return { type: 'denied', authorizationClass: classification };
  const managed = extractions.find(extraction => extraction.type === 'capability');
  if (managed?.type === 'capability')
    return { type: 'managed', value: managed.value, authorizationClass: classification };
  const basic = parseGitAuthorization(authorization);
  // Unsupported carriers cannot turn a managed secret into caller-owned authority.
  if (
    RAW_CREDENTIAL_FAMILY.test(
      `${authorization ?? ''} ${privateToken ?? ''} ${basic?.username ?? ''} ${basic?.password ?? ''}`
    )
  )
    return { type: 'denied', authorizationClass: 'unsupported-managed' };
  return { type: 'unmanaged', authorizationClass: classification };
}
