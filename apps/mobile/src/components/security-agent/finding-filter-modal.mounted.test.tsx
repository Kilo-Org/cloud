import { DEFAULT_SECURITY_FINDING_FILTERS } from '@kilocode/app-shared/security-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { FindingFilterModal } from './finding-filter-modal';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/radio-group', () => ({ RadioGroup: 'RadioGroup' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let mounted: RenderWithProvidersResult | null = null;

async function mount(repositories: { fullName: string }[]) {
  const result = await renderWithProviders(
    <FindingFilterModal
      filters={DEFAULT_SECURITY_FINDING_FILTERS}
      repositories={repositories}
      onChange={() => undefined}
    />
  );
  mounted = result;
  return result.renderer;
}

/** Every string the sheet renders, in render order. */
function renderedStrings(renderer: RenderWithProvidersResult['renderer']): string[] {
  return renderer.root
    .findAll(n => typeof n.type === 'string' && (n.type as string) === 'Text')
    .map(n => n.props.children)
    .filter((child): child is string => typeof child === 'string');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('FindingFilterModal section labels', () => {
  function sectionTitle(
    renderer: RenderWithProvidersResult['renderer'],
    text: string
  ): { props: Record<string, unknown> } | undefined {
    return renderer.root.findAll(
      n => typeof n.type === 'string' && (n.type as string) === 'Text' && n.props.children === text
    )[0];
  }

  it('keeps the eyebrow treatment on a Latin section label', async () => {
    const renderer = await mount([]);

    expect(sectionTitle(renderer, i18n.t('common.repository'))?.props.variant).toBe('eyebrow');
  });

  it('renders an RTL-script section label at the secondary text size and colour', async () => {
    await i18n.changeLanguage('ar');
    try {
      const renderer = await mount([]);
      const title = i18n.t('common.repository');

      expect(title).not.toBe('Repository');
      expect(sectionTitle(renderer, title)?.props.variant).toBe('muted');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('FindingFilterModal repository section', () => {
  it('explains a repository section with nothing to choose from', async () => {
    const renderer = await mount([]);
    const strings = renderedStrings(renderer);
    const titleIndex = strings.indexOf(i18n.t('common.repository'));
    const noteIndex = strings.indexOf(i18n.t('securityAgent.filter.noRepositories'));
    const allRepositoriesIndex = strings.indexOf(i18n.t('common.allRepositories'));

    expect(titleIndex).toBeGreaterThanOrEqual(0);
    // The note sits under the section heading and before the options: it
    // explains the single "All repositories" row rather than replacing it.
    expect(noteIndex).toBeGreaterThan(titleIndex);
    expect(noteIndex).toBeLessThan(allRepositoriesIndex);
  });

  it('leaves the section unannotated when there are repositories to choose from', async () => {
    const renderer = await mount([{ fullName: 'acme/one' }, { fullName: 'acme/two' }]);
    const strings = renderedStrings(renderer);

    expect(strings).not.toContain(i18n.t('securityAgent.filter.noRepositories'));
    expect(strings.indexOf('acme/one')).toBeGreaterThan(
      strings.indexOf(i18n.t('common.repository'))
    );
    expect(strings.indexOf('acme/two')).toBeGreaterThan(strings.indexOf('acme/one'));
  });
});
