/**
 * Authenticated internal-service HTTP calls into the Cloud Agent Worker.
 * The browser-facing tRPC client lives in `./cloud-agent-client`; these
 * `/internal/...` endpoints are only reachable with the internal API key.
 */
import 'server-only';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { fetchWithinBudget } from '@/lib/bounded-service-fetch';
import { approvalKeySchema } from '@kilocode/app-shared/approval-key';
import * as z from 'zod';

const CLOUD_AGENT_NEXT_API_URL = getEnvVariable('CLOUD_AGENT_NEXT_API_URL') || '';

/**
 * Close live Cloud Agent stream sockets for a removed organization member.
 * Best-effort: callers log and continue on failure so member removal never
 * fails because stream close failed.
 */
export async function closeCloudAgentOrgStreams(
  userId: string,
  organizationId: string
): Promise<void> {
  const response = await fetch(`${CLOUD_AGENT_NEXT_API_URL}/internal/streams/close`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-api-key': INTERNAL_API_SECRET,
    },
    body: JSON.stringify({ userId, organizationId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Cloud Agent stream close failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
  }
}

// Optional enrichment that runs after the active-session read inside the native
// widget route's ten-second deadline: a slow identity read drops only the key.
const WIDGET_APPROVAL_KEY_BUDGET_MS = 1_500;

const widgetApprovalKeyResponseSchema = z.object({
  approvalKey: approvalKeySchema,
  // Absent when an older Worker answers; the session card then shows no command.
  command: z.string().max(60).nullable().optional(),
});

/** The approval binding and the pending request's command, both null when none waits. */
export type CloudAgentWidgetApproval = { approvalKey: string | null; command: string | null };

/**
 * The binding of the oldest pending permission on one owned control-plane
 * session: SHA-256 of `JSON.stringify([kiloSessionId, permissionId])`, computed
 * in the Worker so the raw permission never reaches this process, plus that
 * request's command (one trimmed line, at most 60 characters) for the session
 * card. The Worker re-checks user, organization scope and the Kilo/cloud
 * session pairing; the key grants no authority. Bounded, and throws on any
 * non-OK answer so the caller can drop the identity while keeping counts.
 */
export async function readCloudAgentWidgetApprovalKey(
  input: {
    userId: string;
    organizationId: string | null;
    kiloSessionId: string;
    cloudAgentSessionId: string;
  },
  signal?: AbortSignal
): Promise<CloudAgentWidgetApproval> {
  const budget = AbortSignal.timeout(WIDGET_APPROVAL_KEY_BUDGET_MS);
  const response = await fetchWithinBudget(
    `${CLOUD_AGENT_NEXT_API_URL}/internal/widgets/approval-key`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: signal ? AbortSignal.any([budget, signal]) : budget,
    }
  );
  if (!response.ok) {
    throw new Error(`Cloud Agent widget approval key failed: ${response.status}`);
  }
  const parsed = widgetApprovalKeyResponseSchema.parse(await response.json());
  return { approvalKey: parsed.approvalKey, command: parsed.command ?? null };
}

export type VercelSnapshotBuildStartInput = (
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never }
) & {
  credentialId: string;
  buildGeneration: string;
};

/**
 * Start an organization-scoped BYOC Vercel snapshot build through the
 * authenticated Cloud Agent internal API. This is intentionally not part of
 * the browser-facing tRPC client.
 */
export async function startVercelSnapshotBuild(
  input: VercelSnapshotBuildStartInput
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${CLOUD_AGENT_NEXT_API_URL}/internal/byoc/vercel-snapshot-build/start`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': INTERNAL_API_SECRET,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new Error('Cloud Agent snapshot build request failed');
  }

  if (!response.ok) {
    throw new Error('Cloud Agent snapshot build request was rejected');
  }
}

export type VercelRuntimeIdentity = {
  wrapperVersion: string;
  releasedAt: string;
  digest: string;
};

export async function getVercelRuntimeIdentity(): Promise<VercelRuntimeIdentity> {
  let response: Response;
  try {
    response = await fetch(`${CLOUD_AGENT_NEXT_API_URL}/internal/byoc/vercel-runtime-identity`, {
      headers: { 'x-internal-api-key': INTERNAL_API_SECRET },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Cloud Agent runtime identity could not be verified');
  }

  if (!response.ok) {
    throw new Error('Cloud Agent runtime identity could not be verified');
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = z
    .object({
      wrapperVersion: z.string().min(1),
      releasedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      digest: z.string().min(1),
    })
    .safeParse(body);
  if (!parsed.success) {
    throw new Error('Cloud Agent runtime identity could not be verified');
  }
  return parsed.data;
}

export async function getVercelComputeEnrollment(organizationId: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `${CLOUD_AGENT_NEXT_API_URL}/internal/byoc/vercel-enrollment/${encodeURIComponent(organizationId)}`,
      {
        headers: { 'x-internal-api-key': INTERNAL_API_SECRET },
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  if (!response.ok) {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('enrolled' in body) ||
    typeof body.enrolled !== 'boolean'
  ) {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  return body.enrolled;
}

export async function getVercelComputeEnrollmentForUser(userId: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(
      `${CLOUD_AGENT_NEXT_API_URL}/internal/byoc/vercel-enrollment/user/${encodeURIComponent(userId)}`,
      {
        headers: { 'x-internal-api-key': INTERNAL_API_SECRET },
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  if (!response.ok) {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body !== 'object' ||
    body === null ||
    !('enrolled' in body) ||
    typeof body.enrolled !== 'boolean'
  ) {
    throw new Error('Cloud Agent Vercel compute enrollment could not be verified');
  }

  return body.enrolled;
}

/** Exactly one of organizationId or userId must be set. */
export type VercelSnapshotBuildCleanupInput = VercelSnapshotBuildStartInput & {
  snapshotId?: string;
};

export async function cleanupVercelSnapshotBuild(
  input: VercelSnapshotBuildCleanupInput
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${CLOUD_AGENT_NEXT_API_URL}/internal/byoc/vercel-snapshot-build/cleanup`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': INTERNAL_API_SECRET,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new Error('Cloud Agent Vercel compute cleanup could not be completed');
  }

  if (!response.ok) {
    throw new Error('Cloud Agent Vercel compute cleanup could not be completed');
  }
}
