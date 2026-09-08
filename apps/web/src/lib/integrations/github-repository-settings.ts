import 'server-only';
import { z } from 'zod';
import type { RepositoryCustomization, PlatformIntegration } from '@kilocode/db/schema';
import { RepositoryReviewMode } from '@kilocode/db/schema-types';
import { resolveBotModelSlug } from '@/lib/bot/model';

const GitHubReviewModeSchema = z.enum(
  Object.values(RepositoryReviewMode) as [RepositoryReviewMode, ...RepositoryReviewMode[]]
);

/**
 * Settings a GitHub App installation applies to bot mentions and automatic PR
 * reviews when a repository has no override for a given field. Stored in
 * `platform_integrations.metadata`, alongside the existing `model_slug` key —
 * see `mergeGitHubIntegrationMetadata` for the atomic JSONB write.
 */
export const GitHubInstallationSettingsSchema = z
  .object({
    modelSlug: z.string().trim().min(1).max(512).optional(),
    prReviewMode: GitHubReviewModeSchema.optional(),
  })
  .refine(settings => settings.modelSlug !== undefined || settings.prReviewMode !== undefined, {
    message: 'At least one setting must be supplied',
  });
export type GitHubInstallationSettingsInput = z.infer<typeof GitHubInstallationSettingsSchema>;

/**
 * A repository-level override. `null` explicitly restores inheritance from
 * the installation default for that field; omitting a field leaves its
 * current value (override or inherited) untouched.
 */
export const GitHubRepositorySettingsSchema = z
  .object({
    modelSlug: z.string().trim().min(1).max(512).nullable().optional(),
    prReviewMode: GitHubReviewModeSchema.nullable().optional(),
  })
  .refine(settings => settings.modelSlug !== undefined || settings.prReviewMode !== undefined, {
    message: 'At least one setting must be supplied',
  });
export type GitHubRepositorySettingsInput = z.infer<typeof GitHubRepositorySettingsSchema>;

const InstallationReviewModeMetadataSchema = z.object({
  pr_review_mode: z.unknown().optional(),
});

/**
 * Resolves the settings that apply to one repository: any override on
 * `customization` wins; otherwise the installation's default from
 * `integration.metadata` applies. An installation without a recognized
 * `pr_review_mode` (not yet migrated, or invalid) fails closed to `'off'`
 * rather than silently enabling automatic reviews.
 */
export function resolveRepositorySettings(
  integration: Pick<PlatformIntegration, 'metadata'>,
  customization?: Pick<RepositoryCustomization, 'bot_mention_model_slug' | 'pr_review_mode'> | null
) {
  const metadata = InstallationReviewModeMetadataSchema.safeParse(integration.metadata);
  const installationReviewMode = GitHubReviewModeSchema.safeParse(
    metadata.success ? metadata.data.pr_review_mode : undefined
  );

  const modelSlug =
    customization?.bot_mention_model_slug != null
      ? customization.bot_mention_model_slug
      : resolveBotModelSlug(integration);

  const prReviewMode =
    customization?.pr_review_mode ??
    (installationReviewMode.success ? installationReviewMode.data : 'off');

  return { modelSlug, prReviewMode };
}
