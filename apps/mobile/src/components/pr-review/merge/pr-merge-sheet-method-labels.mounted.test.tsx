import './pr-merge-sheet.test-mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { hosts, mount } from './pr-merge-sheet.test-support';

function methodChips(renderer: ReactTestRenderer) {
  return hosts(renderer, 'Pressable').map(chip => ({
    announced: chip.props.accessibilityLabel,
    visible: chip.findAll(node => (node.type as string) === 'Text')[0]?.props.children,
  }));
}

afterEach(async () => {
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

describe('PrMergeSheet method chips', () => {
  it('renders the active language after a live language change', async () => {
    const renderer = await mount();
    expect(methodChips(renderer)).toEqual([
      { announced: 'Create a merge commit', visible: 'Merge' },
      { announced: 'Squash and merge', visible: 'Squash' },
      { announced: 'Rebase and merge', visible: 'Rebase' },
    ]);

    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(methodChips(renderer)).toEqual([
      { announced: 'Merge-Commit erstellen', visible: 'Zusammenführen' },
      { announced: 'Commits bündeln und zusammenführen', visible: 'Bündeln' },
      { announced: 'Commits neu aufsetzen und zusammenführen', visible: 'Neu aufsetzen' },
    ]);
  });
});
