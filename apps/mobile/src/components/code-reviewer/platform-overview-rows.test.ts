// The overview focus-areas row labels every stored focus area. A stored area
// outside REVIEW_FOCUS_AREAS (focus_areas is z.array(z.string()) at every
// persistence boundary) must render localized fallback copy that still names
// the raw code, never a bare English word inside a translated list.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_CAPABILITIES, type ReviewConfigData } from '@/lib/code-reviewer-config';
import { formatNumber } from '@/lib/format';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { buildOverviewRows } from './platform-overview-rows';

import { i18n } from '@/i18n';

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

const capabilities = PLATFORM_CAPABILITIES.github;

function makeConfig(over: Partial<ReviewConfigData> = {}): ReviewConfigData {
  const base = {
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
  } satisfies Partial<ReviewConfigData>;
  return base as ReviewConfigData;
}

function focusSubtitle(config: ReviewConfigData): string {
  const focusRow = buildOverviewRows({
    data: config,
    capabilities,
    models: [],
    modelsLoading: false,
    onOpenModelPicker: () => undefined,
  }).find(row => row.field === 'focus-areas');
  if (!focusRow) {
    throw new Error('focus-areas row not found');
  }
  return focusRow.subtitle;
}

describe('buildOverviewRows model label', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  function modelSubtitle(config: ReviewConfigData, models: ModelOption[]): string {
    const row = buildOverviewRows({
      data: config,
      capabilities,
      models,
      modelsLoading: false,
      onOpenModelPicker: () => undefined,
    }).find(candidate => candidate.field === 'model');
    if (!row) {
      throw new Error('model row not found');
    }
    return row.subtitle;
  }

  it('names the selected Auto model the way the picker does, in the app language', async () => {
    await i18n.changeLanguage('de');

    expect(
      modelSubtitle(makeConfig({ modelSlug: 'kilo-auto/efficient' }), [
        { id: 'kilo-auto/efficient', name: 'Auto Efficient', variants: [], isPreferred: true },
      ])
    ).toBe('Auto Effizient');
  });

  it('keeps the stored slug for a model the catalogue no longer carries', () => {
    expect(modelSubtitle(makeConfig({ modelSlug: 'kilo-auto/retired' }), [])).toBe(
      'kilo-auto/retired'
    );
  });
});

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
    expect(focusSubtitle(makeConfig({ focusAreas: ['constructor'] }))).toBe('Other (constructor)');
  });
});

// The row is the only way into the instructions editor, so it stays on the
// overview for a config with nothing stored: an emptied field must not take
// the entry point down with it.
describe('buildOverviewRows instructions row', () => {
  function instructionsRow(config: ReviewConfigData) {
    const row = buildOverviewRows({
      data: config,
      capabilities,
      models: [],
      modelsLoading: false,
      onOpenModelPicker: () => undefined,
    }).find(candidate => candidate.field === 'instructions');
    if (!row) {
      throw new Error('instructions row not found');
    }
    return row;
  }

  it('offers the editor with a not-set value when nothing is stored', () => {
    expect(instructionsRow(makeConfig({ customInstructions: null })).subtitle).toBe('Not set');
  });

  it('treats a blank stored value as nothing stored', () => {
    expect(instructionsRow(makeConfig({ customInstructions: '  \n ' })).subtitle).toBe('Not set');
  });

  it('marks stored instructions as set', () => {
    expect(instructionsRow(makeConfig({ customInstructions: 'Prefer small diffs' })).subtitle).toBe(
      'Set'
    );
  });
});

// The repositories row states the count of repositories the review covers, so
// the participle in its subtitle has to agree with the number beside it.
// Twenty catalogs restated the plural participle under the `one` category
// that i18next selects at a count of one, and the row read "1 selecionados" in
// Portuguese. Both forms are pinned through the real row builder at the counts
// that language's plural rules distinguish, so a `_one` entry that repeats the
// plural word fails here.
describe('buildOverviewRows repositories row count', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  /**
   * The singular copy each catalog now carries, and the plural every count
   * above one still renders. Catalan, Romanian, Welsh, Maltese and Hebrew
   * select their `two` or `few` category at two, whose value repeats the plural.
   */
  const catalogs = [
    {
      language: 'pt-BR',
      one: '{{displayCount}} selecionado',
      plural: '{{displayCount}} selecionados',
    },
    {
      language: 'pt',
      one: '{{displayCount}} selecionado',
      plural: '{{displayCount}} selecionados',
    },
    {
      language: 'es',
      one: '{{displayCount}} seleccionado',
      plural: '{{displayCount}} seleccionados',
    },
    {
      language: 'gl',
      one: '{{displayCount}} seleccionado',
      plural: '{{displayCount}} seleccionados',
    },
    {
      language: 'ca',
      one: '{{displayCount}} àrea seleccionada',
      plural: '{{displayCount}} àrees seleccionades',
    },
    {
      language: 'it',
      one: 'Selezionato: {{displayCount}}',
      plural: 'Selezionati: {{displayCount}}',
    },
    { language: 'el', one: 'Επιλεγμένο: {{displayCount}}', plural: 'Επιλεγμένα: {{displayCount}}' },
    { language: 'ro', one: '{{displayCount}} selectat', plural: '{{displayCount}} selectate' },
    { language: 'bg', one: '{{displayCount}} избрано', plural: '{{displayCount}} избрани' },
    { language: 'mk', one: '{{displayCount}} избрано', plural: '{{displayCount}} избрани' },
    {
      language: 'cy',
      one: "{{displayCount}} wedi'i ddewis",
      plural: "{{displayCount}} wedi'u dewis",
    },
    { language: 'pa', one: '{{displayCount}} ਚੁਣਿਆ ਗਿਆ', plural: '{{displayCount}} ਚੁਣੇ ਗਏ' },
    {
      language: 'sw',
      one: '{{displayCount}} imechaguliwa',
      plural: '{{displayCount}} zimechaguliwa',
    },
    { language: 'am', one: '{{displayCount}} ተመርጧል', plural: '{{displayCount}} የተመረጡ' },
    { language: 'he', one: '{{displayCount}} נבחר', plural: '{{displayCount}} נבחרו' },
    {
      language: 'ta',
      one: 'தேர்ந்தெடுக்கப்பட்டது: {{displayCount}}',
      plural: 'தேர்ந்தெடுத்தவை: {{displayCount}}',
    },
    { language: 'mt', one: '{{displayCount}} magħżul', plural: '{{displayCount}} magħżula' },
    { language: 'sq', one: '{{displayCount}} zgjedhur', plural: '{{displayCount}} të zgjedhura' },
    { language: 'sv', one: 'Valt: {{displayCount}}', plural: 'Valda: {{displayCount}}' },
    {
      language: 'om',
      one: '{{displayCount}} filatame',
      plural: '{{displayCount}} filatamaniiru',
    },
  ] as const;

  function repositoriesSubtitle(config: ReviewConfigData): string {
    const row = buildOverviewRows({
      data: config,
      capabilities,
      models: [],
      modelsLoading: false,
      onOpenModelPicker: () => undefined,
    }).find(candidate => candidate.field === 'repos');
    if (!row) {
      throw new Error('repos row not found');
    }
    return row.subtitle;
  }

  function selected(ids: readonly string[]): ReviewConfigData {
    return makeConfig({ repositorySelectionMode: 'selected', selectedRepositoryIds: [...ids] });
  }

  // The row binds the formatted figure, so the expectation replaces the token
  // with the same `formatNumber` output the builder passes in.
  function copy(template: string, count: number, language: string): string {
    return template.replace('{{displayCount}}', formatNumber(count, language));
  }

  it('inflects the participle at a count of one', async () => {
    for (const catalog of catalogs) {
      // One instance holds one language at a time, so the catalogs load in sequence.
      // eslint-disable-next-line no-await-in-loop
      await i18n.changeLanguage(catalog.language);
      expect(repositoriesSubtitle(selected(['1001']))).toBe(copy(catalog.one, 1, catalog.language));
    }
  });

  it('keeps the plural participle above one', async () => {
    for (const catalog of catalogs) {
      // eslint-disable-next-line no-await-in-loop
      await i18n.changeLanguage(catalog.language);
      expect(repositoriesSubtitle(selected(['1001', '1002']))).toBe(
        copy(catalog.plural, 2, catalog.language)
      );
    }
  });
});
