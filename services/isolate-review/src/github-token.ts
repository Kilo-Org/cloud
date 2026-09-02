import { z } from 'zod';
import type { GitTokenService, StartReviewInput } from './types';

const tokenResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    token: z.string().trim().min(1).max(8_192),
    installationId: z.string().min(1).max(256),
    appType: z.enum(['standard', 'lite']),
  }),
  z.object({
    success: z.literal(false),
    reason: z.enum([
      'database_not_configured',
      'invalid_repo_format',
      'no_installation_found',
      'repository_not_installed',
      'invalid_org_id',
      'integration_mismatch',
      'ambiguous_installation',
    ]),
  }),
]);

export type GithubCredentials = {
  token: string;
  installationId?: string;
  appType?: 'standard' | 'lite';
};

export class GithubTokenResolutionError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub token unavailable: ${reason}`);
    this.name = 'GithubTokenResolutionError';
  }
}

/** Direct tokens are only an offline-fixture seam; deployed production runs use the RPC. */
export function allowsDirectGithubToken(environment: string | undefined): boolean {
  const normalized = environment?.trim().toLowerCase();
  return normalized === 'development' || normalized === 'test';
}

export async function resolveGithubCredentials(options: {
  input: StartReviewInput;
  service?: GitTokenService;
  allowDirectToken: boolean;
}): Promise<GithubCredentials> {
  const { input } = options;
  const directToken = input.gitToken?.trim();
  if (directToken && options.allowDirectToken) {
    if (
      input.expectedIntegrationId !== undefined ||
      input.expectedInstallationId !== undefined ||
      input.expectedAppType !== undefined
    ) {
      throw new GithubTokenResolutionError(
        'direct fixture tokens cannot prove installation identity'
      );
    }
    return { token: directToken };
  }

  const userId = input.userId?.trim();
  if (userId) {
    if (!options.service) {
      throw new GithubTokenResolutionError('git-token-service binding is not configured');
    }

    const orgId = input.organizationId?.trim();
    if (
      !orgId &&
      input.expectedIntegrationId !== undefined &&
      (input.expectedInstallationId === undefined || input.expectedAppType === undefined)
    ) {
      throw new GithubTokenResolutionError(
        'Personal prepared reviews require installation and app identity'
      );
    }
    let parsed: ReturnType<typeof tokenResultSchema.safeParse>;
    try {
      const rawResult: unknown = await options.service.getTokenForRepo({
        githubRepo: `${input.owner}/${input.repo}`,
        userId,
        ...(orgId ? { orgId } : {}),
        ...(orgId && input.expectedIntegrationId !== undefined
          ? { expectedIntegrationId: input.expectedIntegrationId }
          : {}),
      });
      try {
        parsed = tokenResultSchema.safeParse(rawResult);
      } finally {
        if (typeof rawResult === 'object' && rawResult !== null && Symbol.dispose in rawResult) {
          const dispose = rawResult[Symbol.dispose];
          if (typeof dispose === 'function') dispose.call(rawResult);
        }
      }
    } catch {
      throw new GithubTokenResolutionError('git-token-service RPC failed');
    }

    if (!parsed.success) {
      throw new GithubTokenResolutionError(
        'git-token-service returned invalid credentials or identity'
      );
    }
    const result = parsed.data;
    if (!result.success) throw new GithubTokenResolutionError(result.reason);
    if (
      input.expectedInstallationId !== undefined &&
      input.expectedInstallationId !== result.installationId
    ) {
      throw new GithubTokenResolutionError(
        'GitHub installation does not match the prepared identity'
      );
    }
    if (input.expectedAppType !== undefined && input.expectedAppType !== result.appType) {
      throw new GithubTokenResolutionError('GitHub App type does not match the prepared identity');
    }
    if (result.appType === 'lite' && input.dryRun === false) {
      throw new GithubTokenResolutionError('GitHub Lite installations cannot publish reviews');
    }
    return { token: result.token, installationId: result.installationId, appType: result.appType };
  }

  if (directToken) {
    throw new GithubTokenResolutionError('direct GitHub tokens are disabled in production');
  }
  throw new GithubTokenResolutionError('userId is required');
}

export async function resolveGithubToken(
  options: Parameters<typeof resolveGithubCredentials>[0]
): Promise<string> {
  return (await resolveGithubCredentials(options)).token;
}
