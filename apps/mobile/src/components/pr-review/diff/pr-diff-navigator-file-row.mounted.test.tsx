// The navigator row paints a file path. Android mirrors a `flex-row` under a
// right-to-left interface, so the directory and the basename must be inline runs
// in one `Text` — as sibling `Text`s the row reverses them and `src/greeting.ts`
// reads `greeting.tssrc/`. The isolate pins the run's order for a path that
// starts with a digit or a neutral.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { NavigatorFileRow } from './pr-diff-navigator-file-row';
import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', async () => {
  // A `vi.mock` factory runs before this file's imports are initialised, so the
  // shared flatten comes in dynamically; a static import would be unbound here.
  // The shared `Text` reads a caller's own base direction through
  // `StyleSheet.flatten` (`pinsTextDirection`), so this stub must flatten.
  const { flattenStyle: flatten } = await import('@/test/style-sheet-mock');
  return {
    I18nManager: i18nManager,
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, flatten },
    Text: 'Text',
    View: 'View',
  };
});
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/pr-review/diff/pr-diff-file-rows', () => ({
  MarkViewedToggle: 'MarkViewedToggle',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

const DIRECTORY_RUN = `${LTR_ISOLATE_OPEN}src/`;
const BASENAME_RUN = `greeting.ts${LTR_ISOLATE_CLOSE}`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  i18nManager.isRTL = false;
});

/** The single `Text` that holds the whole path: one line, middle ellipsis. */
function pathParagraph(): TestRenderer.ReactTestInstance {
  if (!renderer) {
    throw new Error('the row did not render');
  }
  const [paragraph] = renderer.root.findAll(
    node => Object.is(node.type, 'Text') && node.props.ellipsizeMode === 'middle'
  );
  if (!paragraph) {
    throw new Error('the row renders no single-line path');
  }
  return paragraph;
}

function inlineRuns(runs: readonly (TestRenderer.ReactTestInstance | string)[]) {
  return runs.filter((run): run is TestRenderer.ReactTestInstance => typeof run !== 'string');
}

function mountRow(
  path: string,
  patchMissingCause: Parameters<typeof NavigatorFileRow>[0]['file']['patchMissingCause'] = null
): void {
  i18nManager.isRTL = true;
  act(() => {
    renderer = TestRenderer.create(
      createElement(NavigatorFileRow, {
        file: {
          path,
          previousPath: null,
          status: 'modified',
          additions: 3,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";',
          patchMissingCause,
        },
        viewed: false,
        onSelect: () => undefined,
        onToggleViewed: () => undefined,
      })
    );
  });
}

describe('NavigatorFileRow path under an RTL interface', () => {
  it('draws the directory and the basename as one isolated left-to-right run', () => {
    mountRow('src/greeting.ts');
    const paragraph = pathParagraph();

    expect(paragraph.props.numberOfLines).toBe(1);

    // Logical order inside one paragraph: the isolate opens at the directory
    // and closes after the basename, so no row mirroring can swap them and a
    // right-to-left paragraph still reads `src/greeting.ts`.
    const [directory, basename] = inlineRuns(paragraph.children);
    expect(directory?.props.children).toBe(DIRECTORY_RUN);
    expect(basename?.props.children).toBe(BASENAME_RUN);
  });

  it('keeps the muted directory and the medium-weight basename', () => {
    mountRow('src/greeting.ts');
    if (!renderer) {
      throw new Error('the row did not render');
    }
    // The shared `Text` merges the variant and caller classes on the host node.
    const hosts = renderer.root.findAll(
      node => Object.is(node.type, 'Text') && typeof node.props.children === 'string'
    );
    const directory = hosts.find(node => node.props.children === DIRECTORY_RUN);
    const basename = hosts.find(node => node.props.children === BASENAME_RUN);

    const directoryStyle = Object.assign(
      {},
      ...([directory?.props.style] as Record<string, unknown>[]).flat()
    );
    expect(directoryStyle).toMatchObject({
      color: '#888888',
      direction: 'ltr',
      writingDirection: 'ltr',
    });
    expect(directory?.props.className).toContain('text-muted-foreground');
    // Both runs keep the row's size: the shared `Text` default variant would
    // paint a nested run at `text-base` and grow the path's line box.
    expect(directory?.props.className).toContain('text-sm');

    const basenameStyle = Object.assign(
      {},
      ...([basename?.props.style] as Record<string, unknown>[]).flat()
    );
    expect(basenameStyle).toMatchObject({ direction: 'ltr', writingDirection: 'ltr' });
    expect(basename?.props.className).toContain('font-medium');
    expect(basename?.props.className).toContain('text-sm');
  });

  it('opens the isolate at the basename when the path has no directory', () => {
    mountRow('README.md');
    const [basename] = inlineRuns(pathParagraph().children);

    expect(basename?.props.children).toBe(`${LTR_ISOLATE_OPEN}README.md${LTR_ISOLATE_CLOSE}`);
  });
});

const ADDITIONS_RUN = `${LTR_ISOLATE_OPEN}+3${LTR_ISOLATE_CLOSE}`;
const DELETIONS_RUN = `${LTR_ISOLATE_OPEN}-1${LTR_ISOLATE_CLOSE}`;

describe('NavigatorFileRow diff stats under an RTL interface', () => {
  it('keeps each signed count in its own isolated left-to-right run', () => {
    mountRow('src/greeting.ts');
    if (!renderer) {
      throw new Error('the row did not render');
    }
    // Each count is its own run, so the sign must be isolated inside it: the
    // RTL paragraph would otherwise move the neutral sign behind the number.
    const hosts = renderer.root.findAll(
      node => Object.is(node.type, 'Text') && typeof node.props.children === 'string'
    );
    const additions = hosts.find(node => node.props.children === ADDITIONS_RUN);
    const deletions = hosts.find(node => node.props.children === DELETIONS_RUN);

    expect(additions?.props.className).toContain('text-muted-foreground');
    expect(additions?.props.className).toContain('text-xs');
    expect(deletions?.props.className).toContain('text-muted-foreground');
    expect(deletions?.props.className).toContain('text-xs');
  });
});

describe('NavigatorFileRow mark-viewed toggle', () => {
  it('sits directly in the padded row, so its slop is inside the parent view', () => {
    mountRow('src/greeting.ts');
    const toggle = renderer?.root.find(node => Object.is(node.type, 'MarkViewedToggle'));
    const parentClass = String(toggle?.parent?.props.className);

    expect(parentClass).toContain('py-2.5');
    expect(parentClass).toContain('flex-row');
  });
});

/**
 * The navigator names why a file has no patch, in the same four terms the diff
 * row uses. A file that carried a patch says nothing here: its counts already
 * fill the line.
 */
describe('NavigatorFileRow patch-missing note', () => {
  function paintedTexts(): string[] {
    return (
      renderer?.root
        .findAll(node => Object.is(node.type, 'Text') && typeof node.props.children === 'string')
        .map(node => String(node.props.children)) ?? []
    );
  }

  it.each([
    ['too_large', 'prReview.fileNavigator.diffTooLarge'],
    ['binary', 'prReview.fileNavigator.binaryDiff'],
    ['provider_omitted', 'prReview.fileNavigator.diffUnavailable'],
    ['content_unchanged', 'prReview.fileNavigator.contentUnchanged'],
  ] as const)('paints %s from its own key', (cause, key) => {
    mountRow('assets/photo.png', cause);
    expect(paintedTexts()).toContain(i18n.t(key));
  });

  it('paints no note when the file carried a patch', () => {
    mountRow('src/greeting.ts');
    const texts = paintedTexts();
    for (const key of [
      'prReview.fileNavigator.diffTooLarge',
      'prReview.fileNavigator.binaryDiff',
      'prReview.fileNavigator.diffUnavailable',
      'prReview.fileNavigator.contentUnchanged',
    ] as const) {
      expect(texts).not.toContain(i18n.t(key));
    }
  });
});
