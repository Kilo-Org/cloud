import type { CodeReviewPlatform, GateThreshold, ReviewStyle } from './enums';

// Wire shape of a per-repository model override. Mirrors the tRPC input/output
// contract (camelCase); the persisted snake_case shape lives in
// RepositoryModelOverrideSchema in @kilocode/db/schema-types.
export type RepositoryModelOverrideInput = {
  repositoryId: number | string;
  repoFullName: string;
  modelSlug: string;
  thinkingEffort: string | null;
};

// Structural shape of the review config a save request is built from —
// matches apps/mobile/src/lib/code-reviewer-config.ts's ReviewConfigData
// (mobile keeps that name/type locally, derived from its tRPC query output;
// this is only the subset buildSaveConfigInput actually reads).
export type CodeReviewConfigInput = {
  reviewStyle: ReviewStyle;
  focusAreas: string[];
  customInstructions: string | null;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: GateThreshold;
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
  disableReviewMd: boolean;
};

export type CodeReviewConfigPatch = Partial<{
  reviewStyle: ReviewStyle;
  focusAreas: string[];
  customInstructions: string;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: GateThreshold;
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
  disableReviewMd: boolean;
}>;

// Ported verbatim from apps/mobile/src/lib/code-reviewer-config.ts.
//
// This is mobile-flavored, not a shared web/mobile rule: web's
// ReviewConfigForm.tsx builds its save payload inline and does NOT force
// 'selected' repo mode or a fixed autoConfigureWebhooks for gitlab — it
// exposes autoConfigureWebhooks as a user-toggleable checkbox (default true)
// and only forces repositorySelectionMode to 'selected' in local UI state
// (via a useEffect keyed off isGitLab), and it never sends bitbucket at all
// (ReviewConfigForm's Platform type is 'github' | 'gitlab' only). So this
// function stays mobile's rule, ported unchanged; web is not adapted to it.
export function buildSaveConfigInput(
  platform: CodeReviewPlatform,
  config: CodeReviewConfigInput,
  patch: CodeReviewConfigPatch
) {
  return {
    platform,
    reviewStyle: config.reviewStyle,
    focusAreas: config.focusAreas,
    customInstructions: config.customInstructions ?? undefined,
    modelSlug: config.modelSlug,
    thinkingEffort: config.thinkingEffort,
    gateThreshold: config.gateThreshold,
    // GitLab and Bitbucket only support 'selected' repo mode server-side; the
    // mode picker only exists for github, so force it here instead of relying
    // on a config default that can still be 'all'.
    repositorySelectionMode:
      platform === 'gitlab' || platform === 'bitbucket'
        ? ('selected' as const)
        : config.repositorySelectionMode,
    selectedRepositoryIds: config.selectedRepositoryIds,
    // Preserve web-created overrides across mobile settings edits (mobile has no
    // override editing UI in v1). The server prunes these to the current selection.
    repositoryModelOverrides: config.repositoryModelOverrides,
    disableReviewMd: config.disableReviewMd,
    ...(platform === 'gitlab' ? { autoConfigureWebhooks: true as const } : {}),
    ...patch,
  };
}
