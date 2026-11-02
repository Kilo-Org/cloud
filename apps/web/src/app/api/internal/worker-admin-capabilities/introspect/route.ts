import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { kilocode_users } from '@kilocode/db/schema';
import {
  WORKER_ADMIN_AUDIENCES,
  WorkerAdminTargetSchema,
  findWorkerAdminAction,
  workerAdminBindingDigest,
  workerAdminServiceTarget,
} from '@kilocode/worker-utils/worker-admin-capability';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';

const BodySchema = z
  .object({
    jti: z.string().min(1).max(200),
    sub: z.string().min(1),
    aud: z.enum(WORKER_ADMIN_AUDIENCES),
    action: z.string().min(1).max(200),
    target: WorkerAdminTargetSchema,
    bnd: z.object({ pep: z.string(), wsp: z.string() }).strict(),
  })
  .strict();

/**
 * Revoked issuance ids. The v1 set is empty because capabilities live at most
 * five minutes; the hook exists so a revocation path can land without changing
 * the Worker contract.
 */
const revokedIssuanceIds = new Set<string>();

type IntrospectionResult = { active: boolean; reason?: string };

async function introspect(body: z.infer<typeof BodySchema>): Promise<IntrospectionResult> {
  if (revokedIssuanceIds.has(body.jti)) return { active: false, reason: 'session_revoked' };

  const entry = findWorkerAdminAction(body.aud, body.action);
  if (!entry || entry.targetKind !== body.target.kind) {
    return { active: false, reason: 'role_revoked' };
  }
  if (body.target.kind === 'service') {
    const expected = workerAdminServiceTarget(body.aud).id;
    if (body.target.id !== expected) return { active: false, reason: 'role_revoked' };
  }

  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, body.sub),
  });
  if (!user) return { active: false, reason: 'role_revoked' };
  if (user.blocked_at || user.blocked_reason) return { active: false, reason: 'blocked' };
  if (!user.is_admin) return { active: false, reason: 'role_revoked' };

  const expectedPepper = await workerAdminBindingDigest(user.api_token_pepper);
  if (body.bnd.pep !== expectedPepper) return { active: false, reason: 'session_revoked' };

  return { active: true };
}

export async function POST(request: NextRequest) {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;

  const rawBody: unknown = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const result = await introspect(parsed.data);
  return NextResponse.json(result, { status: 200 });
}
