import { type CodeReviewPlatform } from '@kilocode/app-shared/code-review';

export {
  buildSaveConfigInput,
  GATE_THRESHOLDS,
  REVIEW_FOCUS_AREAS,
  REVIEW_STYLES,
} from '@kilocode/app-shared/code-review';

export type ReviewerPlatform = CodeReviewPlatform;

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
