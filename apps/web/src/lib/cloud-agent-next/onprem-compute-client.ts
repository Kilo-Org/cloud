import 'server-only';

import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import {
  onPremEnrollmentResponseSchema,
  onPremOrganizationIdSchema,
  onPremStatusSchema,
  type OnPremEnrollmentRequest,
  type OnPremRevokeRequest,
  type OnPremSelectRequest,
} from '@cloud-agent-shared/onprem-protocol';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { getEnvVariable } from '@/lib/dotenvx';

function unavailable() {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'On-prem compute is unavailable. Try again later.',
  });
}

function invalidResponse() {
  return new TRPCError({
    code: 'BAD_GATEWAY',
    message: 'On-prem compute returned an invalid response. Refresh the status and try again.',
  });
}

function requestFailure(status: number) {
  switch (status) {
    case 400:
    case 422:
      return new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The on-prem compute request was rejected. Check the input and try again.',
      });
    case 403:
      return new TRPCError({
        code: 'FORBIDDEN',
        message: 'This on-prem compute action is not permitted for this organization.',
      });
    case 404:
      return new TRPCError({
        code: 'NOT_FOUND',
        message: 'The on-prem installation was not found. Refresh the status and try again.',
      });
    case 409:
      return new TRPCError({
        code: 'CONFLICT',
        message:
          'The on-prem installation cannot accept this action. Refresh the status and try again.',
      });
    case 412:
      return new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The on-prem installation is not ready for this action.',
      });
    case 429:
      return new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many on-prem compute requests. Try again shortly.',
      });
    default:
      return unavailable();
  }
}

async function requestOnPremCompute<T>(
  organizationId: string,
  path: '' | '/enrollment' | '/select' | '/revoke',
  schema: z.ZodType<T>,
  body?: OnPremEnrollmentRequest | OnPremSelectRequest | OnPremRevokeRequest
): Promise<T> {
  const baseUrl = getEnvVariable('CLOUD_AGENT_NEXT_API_URL');
  if (!baseUrl || !INTERNAL_API_SECRET) throw unavailable();

  let response: Response;
  try {
    const url = new URL(baseUrl);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw unavailable();
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/internal/onprem/organizations/${encodeURIComponent(organizationId)}${path}`;

    response = await fetch(url.toString(), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw unavailable();
  }

  if (!response.ok) throw requestFailure(response.status);
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw invalidResponse();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw invalidResponse();
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

async function requestStatus(
  organizationId: string,
  path: '' | '/select' | '/revoke',
  body?: OnPremSelectRequest | OnPremRevokeRequest
) {
  const canonicalOrganizationId = onPremOrganizationIdSchema.parse(organizationId);
  const status = await requestOnPremCompute(
    canonicalOrganizationId,
    path,
    onPremStatusSchema,
    body
  );
  if (
    (status.installation && status.installation.organizationId !== canonicalOrganizationId) ||
    (body && status.installation?.id !== body.installationId)
  ) {
    throw invalidResponse();
  }
  return status;
}

export function getOnPremComputeStatus(organizationId: string) {
  return requestStatus(organizationId, '');
}

export async function createOnPremEnrollment(
  organizationId: string,
  input: OnPremEnrollmentRequest
) {
  const canonicalOrganizationId = onPremOrganizationIdSchema.parse(organizationId);
  const enrollment = await requestOnPremCompute(
    canonicalOrganizationId,
    '/enrollment',
    onPremEnrollmentResponseSchema,
    input
  );
  if (enrollment.organizationId !== canonicalOrganizationId) throw invalidResponse();
  return enrollment;
}

export function selectOnPremComputeTarget(organizationId: string, input: OnPremSelectRequest) {
  return requestStatus(organizationId, '/select', input);
}

export function revokeOnPremInstallation(organizationId: string, input: OnPremRevokeRequest) {
  return requestStatus(organizationId, '/revoke', input);
}
