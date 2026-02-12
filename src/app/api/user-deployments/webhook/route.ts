import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { deployment_events, deployment_builds, deployments } from '@/db/schema';
import { USER_DEPLOYMENTS_API_AUTH_KEY } from '@/lib/config.server';
import { and, eq, ne } from 'drizzle-orm';
import * as z from 'zod';
import { webhookPayloadSchema, type WebhookPayload } from '@/lib/user-deployments/types';
import { sendDeploymentFailedEmail } from '@/lib/email';
import { findUserById } from '@/lib/user';
import { getOrganizationMembers } from '@/lib/organizations/organizations';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.substring(7);
  if (token !== USER_DEPLOYMENTS_API_AUTH_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    const body = await req.json();
    payload = webhookPayloadSchema.parse(body);
  } catch (error) {
    console.error('Failed to parse payload:', error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid payload', details: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    // Insert all events
    await db
      .insert(deployment_events)
      .values(
        payload.events.map(event => ({
          build_id: payload.buildId,
          event_id: event.id,
          event_type: event.type,
          timestamp: event.ts,
          payload: event.payload,
        }))
      )
      .onConflictDoNothing();

    // Find "building" event and last status change event
    const buildingEvent = payload.events.find(
      event => event.type === 'status_change' && event.payload.status === 'building'
    );
    const lastStatusChangeEvent = payload.events.findLast(event => event.type === 'status_change');

    if (lastStatusChangeEvent) {
      const isCompleted = ['deployed', 'failed', 'cancelled'].includes(
        lastStatusChangeEvent.payload.status
      );
      const isDeployed = lastStatusChangeEvent.payload.status === 'deployed';

      // Update deployment_builds and get deployment_id
      const [updatedBuild] = await db
        .update(deployment_builds)
        .set({
          ...(buildingEvent && { started_at: buildingEvent.ts }),
          status: lastStatusChangeEvent.payload.status,
          ...(isCompleted && { completed_at: lastStatusChangeEvent.ts }),
        })
        .where(
          and(
            eq(deployment_builds.id, payload.buildId),
            ne(deployment_builds.status, lastStatusChangeEvent.payload.status)
          )
        )
        .returning({ deployment_id: deployment_builds.deployment_id });

      // If deployed, update the parent deployment's last_deployed_at and queue for threat scan
      if (isDeployed && updatedBuild) {
        await db
          .update(deployments)
          .set({
            last_deployed_at: lastStatusChangeEvent.ts,
            threat_status: 'pending_scan',
          })
          .where(eq(deployments.id, updatedBuild.deployment_id));
      }

      // If failed, send an email notification to the deployment creator
      const isFailed = lastStatusChangeEvent.payload.status === 'failed';
      if (isFailed && updatedBuild) {
        sendDeploymentFailureNotification(updatedBuild.deployment_id).catch(error => {
          console.error('Failed to send deployment failure email:', error);
        });
      }
    }
  } catch (error) {
    console.error('Failed to process deployment events:', error);
    return NextResponse.json({ error: 'Failed to process deployment events' }, { status: 400 });
  }

  return new NextResponse(null, { status: 200 });
}

async function resolveRecipientEmails(deployment: {
  created_by_user_id: string | null;
  owned_by_organization_id: string | null;
}): Promise<string[]> {
  // Try the deployment creator first
  if (deployment.created_by_user_id) {
    const creator = await findUserById(deployment.created_by_user_id);
    if (creator) {
      return [creator.google_user_email];
    }
  }

  // Fall back to org owners for org-owned deployments
  if (deployment.owned_by_organization_id) {
    const members = await getOrganizationMembers(deployment.owned_by_organization_id);
    return members.filter(m => m.role === 'owner' && m.status === 'active').map(m => m.email);
  }

  return [];
}

async function sendDeploymentFailureNotification(deploymentId: string) {
  const deployment = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
  });

  if (!deployment) {
    return;
  }

  const emails = await resolveRecipientEmails(deployment);

  await Promise.all(
    emails.map(email =>
      sendDeploymentFailedEmail({
        to: email,
        deployment_name: deployment.deployment_slug,
        deployment_url: deployment.deployment_url,
        repository: deployment.repository_source,
      })
    )
  );
}
