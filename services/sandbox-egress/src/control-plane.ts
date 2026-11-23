import { createHash } from 'node:crypto';
import {
  awsProxyEgressClaimsSchema,
  awsEgressPolicySchema,
  awsEgressPublicDeploymentSchema,
  awsEgressSharedIdentitySchema,
  AWS_EGRESS_POLICY_TTL_MS,
  AWS_EGRESS_MAX_CLOCK_SKEW_MS,
  AWS_EGRESS_CONTROL_TIMEOUT_MS,
  AWS_EGRESS_CREDENTIAL_HEADER,
  AWS_EGRESS_IDENTITY_HEADER,
  AWS_EGRESS_TARGET_HEADER,
  type AwsEgressPublicDeployment,
  type AwsEgressSharedIdentity,
} from '@kilocode/worker-utils/aws-egress';
import {
  EgressAuditRequestSchema,
  type EgressAuditRequest,
} from '@kilocode/worker-utils/egress-audit';
import { isAllowedEgressUrl } from '@kilocode/worker-utils/egress-allowlist';
import { cleanEgressHeaders } from '@kilocode/worker-utils/egress-http';
import { readAwsResponse } from '@kilocode/worker-utils/aws-client';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';

export class ControlPlaneUnavailable extends Error {
  constructor() {
    super('AWS egress control plane unavailable');
    this.name = 'ControlPlaneUnavailable';
  }
}

/** Claims select an endpoint. Only a successful Worker policy read authenticates the opaque token. */
export function parseEgressCredential(token: string) {
  if (token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  try {
    return (
      awsProxyEgressClaimsSchema.safeParse(
        JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      ).data ?? null
    );
  } catch {
    return null;
  }
}

export function parseProxyAuthorization(header: string | undefined): string | null {
  if (!header || header.length > 6144) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.toString('base64') !== match[1]) return null;
  const value = decoded.toString('utf8');
  if (!value.startsWith('kilo:')) return null;
  const token = value.slice(5);
  return parseEgressCredential(token) ? token : null;
}

/** Allocation IDs cannot authenticate a cache hit. Include the complete opaque credential proof. */
export function egressCredentialKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createControlPlaneClient(input: {
  origin: string;
  deployment: AwsEgressPublicDeployment;
  identity: AwsEgressSharedIdentity;
  fetch: (request: Request) => Promise<Response>;
  now?: () => number;
}) {
  const origin = new URL(input.origin);
  const deployment = awsEgressPublicDeploymentSchema.parse(input.deployment);
  const identity = awsEgressSharedIdentitySchema.parse(input.identity);
  if (
    origin.protocol !== 'https:' ||
    origin.port ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    deployment.generation !== identity.generation ||
    deployment.stackId !== identity.stackId ||
    deployment.protocolVersion !== identity.protocolVersion
  )
    throw new Error('Invalid AWS egress deployment');
  const now = input.now ?? Date.now;
  function credential(token: string) {
    const claims = parseEgressCredential(token);
    if (
      !claims ||
      claims.exp * 1000 <= now() ||
      claims.generation !== deployment.generation ||
      claims.stackId !== deployment.stackId
    )
      throw new ControlPlaneUnavailable();
    return claims;
  }
  function endpoint(token: string, operation: 'policy' | 'audit' | 'scm') {
    const claims = credential(token);
    const path =
      claims.type === 'aws_build_egress'
        ? `/environment-build/${encodeURIComponent(claims.environmentId)}/${encodeURIComponent(claims.buildId)}/aws-egress/${operation}`
        : `/aws-egress/${encodeURIComponent(claims.sandboxId)}/${operation}`;
    return new URL(path, origin);
  }
  function headers(token: string) {
    return new Headers({
      [AWS_EGRESS_IDENTITY_HEADER]: identity.secret,
      [AWS_EGRESS_CREDENTIAL_HEADER]: token,
    });
  }
  async function accepted(request: Request) {
    try {
      const response = await input.fetch(request);
      if (!response.ok) {
        await response.body?.cancel();
        throw new ControlPlaneUnavailable();
      }
      return response;
    } catch {
      throw new ControlPlaneUnavailable();
    }
  }
  return {
    async loadPolicy(token: string, signal: AbortSignal) {
      const requestedAt = now();
      const claims = credential(token);
      const response = await accepted(
        new Request(endpoint(token, 'policy'), {
          method: 'POST',
          headers: headers(token),
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(AWS_EGRESS_CONTROL_TIMEOUT_MS)]),
        })
      );
      try {
        const policy = awsEgressPolicySchema.parse(
          JSON.parse(await readAwsResponse(response, 65_536))
        );
        if (
          policy.generation !== deployment.generation ||
          policy.stackId !== deployment.stackId ||
          policy.allocationId !== claims.allocationId ||
          policy.sandboxId !== claims.sandboxId ||
          policy.validUntil <= now() ||
          policy.validUntil > now() + AWS_EGRESS_POLICY_TTL_MS + AWS_EGRESS_MAX_CLOCK_SKEW_MS ||
          policy.validUntil > claims.exp * 1000 ||
          policy.interceptedHosts.some(host => !STANDARD_SCM_HOSTS.includes(host))
        )
          throw new ControlPlaneUnavailable();
        const validUntil = Math.min(
          policy.validUntil,
          requestedAt + AWS_EGRESS_POLICY_TTL_MS,
          claims.exp * 1000
        );
        if (validUntil <= now()) throw new ControlPlaneUnavailable();
        return { ...policy, validUntil };
      } catch {
        throw new ControlPlaneUnavailable();
      }
    },
    async recordAudit(token: string, row: EgressAuditRequest, signal: AbortSignal) {
      const auth = headers(token);
      auth.set('Content-Type', 'application/json');
      const response = await accepted(
        new Request(endpoint(token, 'audit'), {
          method: 'POST',
          headers: auth,
          body: JSON.stringify(EgressAuditRequestSchema.parse(row)),
          redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(AWS_EGRESS_CONTROL_TIMEOUT_MS)]),
        })
      );
      await response.body?.cancel();
    },
    async forwardScm(token: string, request: Request, signal: AbortSignal) {
      const target = new URL(request.url);
      if (
        target.protocol !== 'https:' ||
        target.hash ||
        !isAllowedEgressUrl(target, STANDARD_SCM_HOSTS)
      )
        throw new ControlPlaneUnavailable();
      const upstreamHeaders = cleanEgressHeaders(request.headers);
      upstreamHeaders.delete('host');
      upstreamHeaders.set(AWS_EGRESS_IDENTITY_HEADER, identity.secret);
      upstreamHeaders.set(AWS_EGRESS_CREDENTIAL_HEADER, token);
      upstreamHeaders.set(AWS_EGRESS_TARGET_HEADER, target.href);
      const options: RequestInit & { duplex: 'half' } = {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body,
        duplex: 'half',
        redirect: 'manual',
        signal,
      };
      try {
        return await input.fetch(new Request(endpoint(token, 'scm'), options));
      } catch {
        throw new ControlPlaneUnavailable();
      }
    },
  };
}

export type ControlPlaneClient = ReturnType<typeof createControlPlaneClient>;
