import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import { cliSessions } from '@kilocode/db/schema';
import { generateSignedUploadUrl } from '@/lib/r2/cli-sessions';
import { BLOB_TYPES } from '@/routers/cli-sessions-router';

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

const BodySchema = z.object({
  session_id: z.uuid(),
  blob_type: z.enum(BLOB_TYPES),
  content_length: z
    .number()
    .int()
    .positive()
    .max(MAX_CONTENT_LENGTH, `Content length must not exceed ${MAX_CONTENT_LENGTH} bytes (5MB)`),
});

export async function POST(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const bodyResult = BodySchema.safeParse(body);

  if (!bodyResult.success) {
    return NextResponse.json(
      {
        error: 'Invalid request body',
        details: z.treeifyError(bodyResult.error),
      },
      { status: 400 }
    );
  }

  const { session_id, blob_type, content_length } = bodyResult.data;

  const [existingSession] = await db
    .select()
    .from(cliSessions)
    .where(and(eq(cliSessions.session_id, session_id), eq(cliSessions.kilo_user_id, user.id)))
    .limit(1);

  if (!existingSession) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const { signedUrl, key: blobKey } = await generateSignedUploadUrl(
    session_id,
    user.id,
    'sessions',
    blob_type,
    content_length
  );

  const [updatedSession] = await db
    .update(cliSessions)
    .set({ [`${blob_type}_blob_url`]: blobKey })
    .where(and(eq(cliSessions.session_id, session_id), eq(cliSessions.kilo_user_id, user.id)))
    .returning({
      session_id: cliSessions.session_id,
      updated_at: cliSessions.updated_at,
    });

  if (!updatedSession) {
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }

  return NextResponse.json({
    signed_url: signedUrl,
    session_id: updatedSession.session_id,
    updated_at: updatedSession.updated_at,
  });
}
