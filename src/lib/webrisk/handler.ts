import { db } from '@/lib/drizzle';
import { deployments, deployment_threat_detections } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { APP_URL } from '@/lib/constants';
import { SLACK_DEPLOY_THREAT_WEBHOOK_URL } from '@/lib/config.server';
import type { CheckUrlResult, ThreatType } from './web-risk-client';

type Deployment = typeof deployments.$inferSelect;

/**
 * Handle a detected threat for a deployment.
 *
 * 1. Records detection in audit log (deployment_threat_detections table)
 * 2. Updates deployment status to 'flagged' (not disabled)
 * 3. Alerts admins for manual review
 */
export async function handleThreatDetected(
  deployment: Deployment,
  result: CheckUrlResult
): Promise<void> {
  // 1. Record detection in audit log
  await db.insert(deployment_threat_detections).values({
    deployment_id: deployment.id,
    build_id: deployment.last_build_id,
    threat_type: result.threatTypes.join(','),
  });

  // 2. Update deployment status to flagged (not disabled)
  await db
    .update(deployments)
    .set({ threat_status: 'flagged' })
    .where(eq(deployments.id, deployment.id));

  // 3. Alert admin (Slack) for manual review
  await alertAdmins({
    deployment,
    threatTypes: result.threatTypes,
  });
}

type AlertAdminsParams = {
  deployment: Deployment;
  threatTypes: ThreatType[];
};

async function alertAdmins(params: AlertAdminsParams): Promise<void> {
  const { deployment, threatTypes } = params;
  const timestamp = new Date().toISOString();

  console.warn('[THREAT DETECTED]', {
    deploymentId: deployment.id,
    deploymentUrl: deployment.deployment_url,
    deploymentSlug: deployment.deployment_slug,
    threatTypes,
    buildId: deployment.last_build_id,
    timestamp,
  });

  if (SLACK_DEPLOY_THREAT_WEBHOOK_URL) {
    const adminUrl = `${APP_URL}/admin/deployments?search=${encodeURIComponent(deployment.deployment_slug ?? '')}`;
    const textLines = [
      ':rotating_light: *Deploy Threat Detected*',
      deployment.deployment_slug ? `• Deployment: \`${deployment.deployment_slug}\`` : null,
      deployment.deployment_url ? `• URL: ${deployment.deployment_url}` : null,
      `• Threat types: \`${threatTypes.join(', ')}\``,
      `• Deployment ID: \`${deployment.id}\``,
      deployment.last_build_id ? `• Build ID: \`${deployment.last_build_id}\`` : null,
      `• Detected at: \`${timestamp}\``,
      `• <${adminUrl}|View in Admin>`,
    ].filter((line): line is string => line !== null);

    await fetch(SLACK_DEPLOY_THREAT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textLines.join('\n') }),
    }).catch(error => {
      console.error('[DeployThreat] Failed to post to Slack webhook', error);
    });
  }
}
