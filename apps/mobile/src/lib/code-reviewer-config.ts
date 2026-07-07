export type ReviewConfigData = {
  isEnabled: boolean;
  reviewStyle: 'strict' | 'balanced' | 'lenient' | 'roast';
  focusAreas: string[];
  customInstructions: string | null;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: 'off' | 'all' | 'warning' | 'critical';
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: number[];
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
  selectedRepositoryIds: number[];
  disableReviewMd: boolean;
}>;

export function buildSaveConfigInput(config: ReviewConfigData, patch: ConfigPatch) {
  return {
    platform: 'github' as const,
    reviewStyle: config.reviewStyle,
    focusAreas: config.focusAreas,
    customInstructions: config.customInstructions ?? undefined,
    modelSlug: config.modelSlug,
    thinkingEffort: config.thinkingEffort,
    gateThreshold: config.gateThreshold,
    repositorySelectionMode: config.repositorySelectionMode,
    selectedRepositoryIds: config.selectedRepositoryIds,
    disableReviewMd: config.disableReviewMd,
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
