import { timingSafeEqual } from '@kilocode/encryption';
import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  organization_vercel_compute_credentials,
  type OrganizationVercelComputeCredential,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { INTERNAL_API_SECRET } from '@/lib/config.server';

const SetupStatusSchema = z.enum(['pending', 'building', 'ready', 'failed']);
const SetupStepSchema = z
  .enum([
    'validating_access',
    'create_builder',
    'install_system_dependencies',
    'install_node_dependencies',
    'upload_runtime_artifacts',
    'verify_runtime_artifacts',
    'snapshot_builder',
    'create_validator',
    'launch_validator_wrapper',
    'verify_validator_call_home',
    'stop_validator',
    'confirm_terminal',
  ])
  .nullable();

const CredentialUpdateSchema = z
  .object({
    organizationId: z.uuid(),
    buildGeneration: z.uuid(),
    setupStatus: SetupStatusSchema,
    setupStep: SetupStepSchema,
    setupError: z
      .string()
      .regex(/^[a-z0-9_]+$/)
      .max(96)
      .nullable(),
    teamSlug: z.string().min(1).max(256).nullable(),
    projectSlug: z.string().min(1).max(256).nullable(),
    runtimeBuildId: z.string().min(1).max(256).nullable(),
    runtimeSnapshotId: z.string().min(1).max(256).nullable(),
    setupStartedAt: z.iso.datetime().nullable(),
    setupCompletedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.setupStatus !== 'ready') return;
    const required: Array<keyof typeof value> = [
      'projectSlug',
      'runtimeSnapshotId',
      'setupCompletedAt',
    ];
    for (const field of required) {
      if (!value[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'Ready status requires the completed runtime fields',
        });
      }
    }
  });

function responseHeaders(): HeadersInit {
  return { 'Cache-Control': 'no-store' };
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: responseHeaders() });
}

function isAuthorized(request: NextRequest): boolean {
  const presented = request.headers.get('x-internal-api-key');
  return Boolean(
    INTERNAL_API_SECRET && presented && timingSafeEqual(presented, INTERNAL_API_SECRET)
  );
}

function toCredentialResponse(row: OrganizationVercelComputeCredential) {
  return {
    credentialId: row.id,
    organizationId: row.organization_id,
    tokenEncrypted: row.token_encrypted,
    tokenScope: row.token_scope,
    teamId: row.team_id,
    projectId: row.project_id,
    teamSlug: row.team_slug,
    projectSlug: row.project_slug,
    setupStatus: row.setup_status,
    setupStep: row.setup_step,
    setupError: row.setup_error,
    buildGeneration: row.build_generation,
    runtimeBuildId: row.runtime_build_id,
    runtimeSnapshotId: row.runtime_snapshot_id,
    setupStartedAt: row.setup_started_at ? new Date(row.setup_started_at).toISOString() : null,
    setupCompletedAt: row.setup_completed_at
      ? new Date(row.setup_completed_at).toISOString()
      : null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ credentialId: string }> }
): Promise<NextResponse> {
  if (!isAuthorized(request)) return unauthorized();

  const { credentialId } = await params;
  const organizationIdResult = z
    .uuid()
    .safeParse(request.nextUrl.searchParams.get('organizationId'));
  if (!z.uuid().safeParse(credentialId).success || !organizationIdResult.success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders() }
    );
  }
  const organizationId = organizationIdResult.data;

  const row = await db.query.organization_vercel_compute_credentials.findFirst({
    where: and(
      eq(organization_vercel_compute_credentials.id, credentialId),
      eq(organization_vercel_compute_credentials.organization_id, organizationId)
    ),
  });
  if (!row) {
    return NextResponse.json(
      { error: 'Credential not found' },
      { status: 404, headers: responseHeaders() }
    );
  }

  return NextResponse.json(toCredentialResponse(row), { headers: responseHeaders() });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ credentialId: string }> }
): Promise<NextResponse> {
  if (!isAuthorized(request)) return unauthorized();

  const { credentialId } = await params;
  if (!z.uuid().safeParse(credentialId).success) {
    return NextResponse.json(
      { error: 'Invalid request' },
      { status: 400, headers: responseHeaders() }
    );
  }

  const parsed = CredentialUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid status update' },
      { status: 400, headers: responseHeaders() }
    );
  }

  const { data } = parsed;
  const [updated] = await db
    .update(organization_vercel_compute_credentials)
    .set({
      setup_status: data.setupStatus,
      setup_step: data.setupStep,
      setup_error: data.setupError,
      team_slug: data.teamSlug,
      project_slug: data.projectSlug,
      runtime_build_id: data.runtimeBuildId,
      runtime_snapshot_id: data.runtimeSnapshotId,
      setup_started_at: data.setupStartedAt,
      setup_completed_at: data.setupCompletedAt,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(organization_vercel_compute_credentials.id, credentialId),
        eq(organization_vercel_compute_credentials.organization_id, data.organizationId),
        eq(organization_vercel_compute_credentials.build_generation, data.buildGeneration)
      )
    )
    .returning({ id: organization_vercel_compute_credentials.id });

  return NextResponse.json({ updated: Boolean(updated) }, { headers: responseHeaders() });
}
