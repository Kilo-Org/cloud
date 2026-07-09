export type ReviewerPlatform = 'github' | 'gitlab' | 'bitbucket';

export function asReviewerPlatform(value: string): ReviewerPlatform {
  return value === 'gitlab' || value === 'bitbucket' ? value : 'github';
}

export const PLATFORM_CAPABILITIES: Record<
  ReviewerPlatform,
  {
    scopes: 'all' | 'org';
    selectionModePicker: boolean;
    gateRow: boolean;
    reviewMd: boolean;
    manualReview: boolean;
    label: string;
  }
> = {
  github: {
    scopes: 'all',
    selectionModePicker: true,
    gateRow: true,
    reviewMd: true,
    manualReview: true,
    label: 'GitHub',
  },
  gitlab: {
    scopes: 'all',
    selectionModePicker: false,
    gateRow: true,
    reviewMd: true,
    manualReview: true,
    label: 'GitLab',
  },
  bitbucket: {
    scopes: 'org',
    selectionModePicker: false,
    gateRow: false,
    reviewMd: false,
    manualReview: false,
    label: 'Bitbucket',
  },
};

export type ReviewConfigData = {
  isEnabled: boolean;
  reviewStyle: 'strict' | 'balanced' | 'lenient' | 'roast';
  focusAreas: string[];
  customInstructions: string | null;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: 'off' | 'all' | 'warning' | 'critical';
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: (number | string)[];
  disableReviewMd: boolean;
};

export type ConfigPatch = Partial<{
  reviewStyle: ReviewConfigData['reviewStyle'];
  focusAreas: string[];
  customInstructions: string;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: ReviewConfigData['gateThreshold'];
  repositorySelectionMode: ReviewConfigData['repositorySelectionMode'];
  selectedRepositoryIds: (number | string)[];
  disableReviewMd: boolean;
}>;

export function buildSaveConfigInput(
  platform: ReviewerPlatform,
  config: ReviewConfigData,
  patch: ConfigPatch
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
    disableReviewMd: config.disableReviewMd,
    ...(platform === 'gitlab' ? { autoConfigureWebhooks: true as const } : {}),
    ...patch,
  };
}

export const REVIEW_STYLES = ['strict', 'balanced', 'lenient', 'roast'] as const;
export const GATE_THRESHOLDS = ['off', 'all', 'warning', 'critical'] as const;
export const FOCUS_AREAS = [
  'security',
  'performance',
  'bugs',
  'style',
  'testing',
  'documentation',
] as const;
