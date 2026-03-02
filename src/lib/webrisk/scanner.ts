import { db } from '@/lib/drizzle';
import { deployments } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createWebRiskClient, type CheckUrlResult } from './web-risk-client';
import { handleThreatDetected } from './handler';

type Deployment = typeof deployments.$inferSelect;

/**
 * Scan a deployment URL for threats using Google Web Risk API.
 *
 * @param deployment - The deployment to scan
 * @returns The scan result, or null if deployment has no URL
 */
export async function scanDeployment(deployment: Deployment): Promise<CheckUrlResult | null> {
  if (!deployment.deployment_url) {
    // No URL to scan - mark as safe so it doesn't stay pending forever
    await db
      .update(deployments)
      .set({ threat_status: 'safe' })
      .where(eq(deployments.id, deployment.id));
    return null;
  }

  const webRisk = createWebRiskClient();
  const result = await webRisk.checkUrl(deployment.deployment_url);

  if (result.isThreat) {
    await handleThreatDetected(deployment, result);
  } else {
    await db
      .update(deployments)
      .set({ threat_status: 'safe' })
      .where(eq(deployments.id, deployment.id));
  }

  return result;
}
