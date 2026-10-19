// The overview focus-areas row labels every stored focus area. A stored area
// outside REVIEW_FOCUS_AREAS (focus_areas is z.array(z.string()) at every
// persistence boundary) must render localized fallback copy that still names
// the raw code, never a bare English word inside a translated list.

import { describe, expect, it, vi } from 'vitest';

import '@/i18n';

// The pure project cannot parse the icon chain (react-native's Flow
// `import typeof` syntax), and the icons are irrelevant to row building.
vi.mock('@/components/ui/icons', () => ({
  Brain: 'Brain',
  FileSliders: 'FileSliders',
  FolderGit2: 'FolderGit2',
  Gauge: 'Gauge',
  MessageSquareText: 'MessageSquareText',
  ScrollText: 'ScrollText',
  ShieldCheck: 'ShieldCheck',
}));

import {
  PLATFORM_CAPABILITIES,
  type ReviewConfigData,
} from '@/lib/code-reviewer-config';
import { buildOverviewRows } from './platform-overview-rows';

const capabilities = PLATFORM_CAPABILITIES.github;

function makeConfig(over: Partial<ReviewConfigData> = {}): ReviewConfigData {
  return {
    isEnabled: true,
    reviewStyle: 'balanced',
    focusAreas: [],
    customInstructions: null,
    modelSlug: 'model',
    thinkingEffort: null,
    gateThreshold: 'off',
    repositorySelectionMode: 'all',
    selectedRepositoryIds: [],
    ...over,
  } as ReviewConfigData;
}

function focusSubtitle(config: ReviewConfigData): string {
  const row = buildOverviewRows({
    data: config,
    capabilities,
    models: [],
    modelsLoading: false,
    onOpenModelPicker: () => {},
  }).find(row => row.field === 'focus-areas');
  if (!row) {
    throw new Error('focus-areas row not found');
  }
  return row.subtitle;
}

describe('buildOverviewRows focus-area labels', () => {
  it('labels known areas with their translated names', () => {
    expect(focusSubtitle(makeConfig({ focusAreas: ['security', 'bugs'] }))).toBe(
      'Security and Bugs'
    );
  });

  it('wraps an unknown stored area in localized fallback copy that still names it', () => {
    expect(focusSubtitle(makeConfig({ focusAreas: ['security', 'correctness'] }))).toBe(
      'Security and Other (correctness)'
    );
  });

  it('labels a config of only unknown areas without leaking a bare code list', () => {
    expect(focusSubtitle(makeConfig({ focusAreas: ['correctness'] }))).toBe('Other (correctness)');
  });

  it('falls back to the all-areas copy for an empty selection', () => {
    expect(focusSubtitle(makeConfig({ focusAreas: [] }))).toBe('All areas');
  });

  it('treats an area named after an inherited object member as unknown, not a label', () => {
    expect(focusSubtitle(makeConfig({ focusAreas: ['constructor'] }))).toBe(
      'Other (constructor)'
    );
  });
});
