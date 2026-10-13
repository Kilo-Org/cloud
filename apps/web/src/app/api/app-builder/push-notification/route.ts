import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { APP_BUILDER_AUTH_TOKEN } from '@kilocode/web-shared/lib/config.server';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const PushNotificationSchema = z.object({
  gitUrl: z.string().url(),
  commitHash: z.string().length(40),
  branch: z.string().min(1),
});

function validateAuthToken(request: Request): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return false;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return false;
  }

  if (!APP_BUILDER_AUTH_TOKEN) {
    logExceptInTest('APP_BUILDER_AUTH_TOKEN is not configured');
    return false;
  }

  return token === APP_BUILDER_AUTH_TOKEN;
}

// Existing App Builder workers still send notifications; acknowledge them without deploying.
export async function POST(request: Request) {
  if (!validateAuthToken(request)) {
    logExceptInTest('Push notification: Invalid or missing auth token');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logExceptInTest('Push notification: Invalid JSON body');
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parseResult = PushNotificationSchema.safeParse(body);
  if (!parseResult.success) {
    logExceptInTest('Push notification: Invalid request body', parseResult.error.issues);
    return NextResponse.json(
      { error: 'Invalid request body', details: parseResult.error.issues },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
