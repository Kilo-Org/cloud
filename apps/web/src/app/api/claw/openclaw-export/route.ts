import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { getUserFromAuth } from '@/lib/user/server';
import { KiloClawApiError, KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  getActiveInstance,
  getActiveOrgInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { requireKiloClawAccess } from '@/lib/kiloclaw/access-gate';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import type { TRPCContext } from '@/lib/trpc/init';

// Large workspaces can take a while to archive; raise the function timeout so
// the streamed download isn't killed mid-flight (mirrors the api-request-log
// download route).
export const maxDuration = 300;

const BodySchema = z.object({
  format: z.enum(['tar.gz', 'zip']),
  password: z.string().min(1).max(256).optional(),
  organizationId: z.uuid().optional(),
});

function jsonError(message: string, status: number, code?: string): Response {
  return new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/claw/openclaw-export
 *
 * Streams the user's OpenClaw workspace as a binary archive (.tar.gz or .zip).
 * Encryption is zip-only; the optional passphrase rides in the POST body (never
 * the URL/logs). Personal and organization instances are both supported, gated
 * by the same helpers the tRPC import procedures compose.
 */
export async function POST(request: NextRequest): Promise<Response> {
  await connection();

  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError('Malformed JSON body', 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonError('Invalid request', 400);
  }
  const { format, password, organizationId } = parsed.data;

  // Encryption is zip-only (UI prevents this; enforce server-side too).
  if (password && format !== 'zip') {
    return jsonError(
      'Encryption is only supported for zip exports',
      400,
      'openclaw_export_encryption_unsupported'
    );
  }

  let instance: Awaited<ReturnType<typeof getActiveInstance>>;
  try {
    if (organizationId) {
      await ensureOrganizationAccess({ user } as TRPCContext, organizationId);
      await requireActiveSubscriptionOrTrial(organizationId);
      instance = await getActiveOrgInstance(user.id, organizationId);
    } else {
      await requireKiloClawAccess(user.id);
      instance = await getActiveInstance(user.id);
    }
  } catch (err) {
    if (err instanceof TRPCError) {
      if (err.code === 'FORBIDDEN' || err.code === 'UNAUTHORIZED') {
        return jsonError(err.message, 403);
      }
      if (err.code === 'NOT_FOUND') {
        return jsonError(err.message, 404);
      }
    }
    console.error('[openclaw-export] failed to resolve instance access:', err);
    return jsonError('Failed to resolve KiloClaw instance', 500);
  }

  if (!instance) {
    return jsonError('No active KiloClaw instance found', 404, 'instance_not_found');
  }

  const client = new KiloClawInternalClient();
  let workerResponse: Response;
  try {
    workerResponse = await client.exportOpenclawWorkspace(
      user.id,
      { format, password },
      workerInstanceId(instance)
    );
  } catch (err) {
    if (err instanceof KiloClawApiError) {
      // The worker already sanitizes export error bodies; forward verbatim.
      return new Response(err.responseBody || JSON.stringify({ error: 'Export failed' }), {
        status: err.statusCode,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.error('[openclaw-export] export request failed:', err);
    return jsonError('Export failed', 500);
  }

  const contentType =
    workerResponse.headers.get('content-type') ??
    (format === 'zip' ? 'application/zip' : 'application/gzip');

  return new Response(workerResponse.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="openclaw-workspace-export.${format}"`,
      'X-Openclaw-Export-File-Count':
        workerResponse.headers.get('x-openclaw-export-file-count') ?? '0',
      'X-Openclaw-Export-Total-Bytes':
        workerResponse.headers.get('x-openclaw-export-total-bytes') ?? '0',
      'X-Openclaw-Export-Skipped': workerResponse.headers.get('x-openclaw-export-skipped') ?? '0',
      // Expose the metadata headers to the browser fetch() for telemetry.
      'Access-Control-Expose-Headers':
        'X-Openclaw-Export-File-Count, X-Openclaw-Export-Total-Bytes, X-Openclaw-Export-Skipped',
    },
  });
}
