import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureException } from '@sentry/nextjs';
import { eq, and } from 'drizzle-orm';
import { APP_BUILDER_AUTH_TOKEN } from '@/lib/config.server';
import { logExceptInTest } from '@/lib/utils.server';
import { db } from '@/lib/drizzle';
import { deployments } from '@kilocode/db/schema';
import { redeploy } from '@/lib/user-deployments/deployments-service';

/**
 * Request body schema for push notification
 */
const PushNotificationSchema = z.object({
  gitUrl: z.string().url(),
  commitHash: z.string().length(40),
  branch: z.string().min(1),
});

type PushNotificationPayload = z.infer<typeof PushNotificationSchema>;

/**
 * Validate Bearer token from Authorization header
 */
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

/**
 * POST /api/app-builder/push-notification
 *
 * Receives push notifications from cloudflare-app-builder when a git push occurs.
 * Triggers a deploy for the corresponding project's deployment.
 */
export async function POST(request: Request) {
  // 1. Validate authentication
  if (!validateAuthToken(request)) {
    logExceptInTest('Push notification: Invalid or missing auth token');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse and validate request body
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

  const payload: PushNotificationPayload = parseResult.data;

  // 3. Look up deployments by repository_source (gitUrl) and branch
  const matchingDeployments = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.repository_source, payload.gitUrl),
        eq(deployments.branch, payload.branch),
        eq(deployments.source_type, 'app-builder')
      )
    );

  if (matchingDeployments.length === 0) {
    logExceptInTest('Push notification: No matching deployments found', {
      repository: payload.gitUrl,
      branch: payload.branch,
    });
    return NextResponse.json({ success: true }, { status: 200 });
  }

  // 4. Trigger deploy for all matching deployments
  await Promise.allSettled(
    matchingDeployments.map(async deployment => {
      try {
        await redeploy(deployment);
      } catch (error) {
        logExceptInTest('Push notification: Failed to trigger redeployment', {
          deploymentId: deployment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, {
          tags: {
            source: 'app_builder_push_notification',
            event: 'push',
            deploymentId: deployment.id,
          },
          extra: {
            repository: payload.gitUrl,
            branch: payload.branch,
            commitHash: payload.commitHash,
          },
        });
      }
    })
  );

  return NextResponse.json({ success: true }, { status: 200 });
}
