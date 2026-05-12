/**
 * Client for the kilo-deploy-builder service.
 * Handles submitting archive deployments and polling for build status.
 */

import { z } from 'zod';

const buildStatusSchema = z.enum([
  'queued',
  'building',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
]);

export type BuildStatus = z.infer<typeof buildStatusSchema>;

const deployArchiveResponseSchema = z.object({
  buildId: z.string(),
  slug: z.string(),
  status: buildStatusSchema,
});

const statusResponseSchema = z.object({
  status: buildStatusSchema,
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  projectType: z.string().optional(),
});

export type BuildStatusResponse = z.infer<typeof statusResponseSchema>;

export type DeployArchiveResult = {
  buildId: string;
  slug: string;
  status: BuildStatus;
};

export class BuilderClient {
  private readonly baseUrl: string;
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.authToken}`,
    };
  }

  /**
   * Upload a tar.gz archive and start a deployment.
   * The slug determines the subdomain: <slug>.d.kiloapps.io
   */
  async deployArchive(slug: string, archive: Uint8Array): Promise<DeployArchiveResult> {
    const response = await fetch(`${this.baseUrl}/deploy-archive`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/octet-stream',
        'X-Slug': slug,
      },
      body: archive,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Builder deploy-archive failed (${response.status}): ${body}`);
    }

    const data: unknown = await response.json();
    return deployArchiveResponseSchema.parse(data);
  }

  /**
   * Poll the status of an in-progress or completed build.
   */
  async getBuildStatus(buildId: string): Promise<BuildStatusResponse> {
    const response = await fetch(`${this.baseUrl}/deploy/${buildId}/status`, {
      headers: this.headers(),
    });

    if (response.status === 404) {
      throw new Error(`Build not found: ${buildId}`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Builder status check failed (${response.status}): ${body}`);
    }

    const data: unknown = await response.json();
    return statusResponseSchema.parse(data);
  }
}
