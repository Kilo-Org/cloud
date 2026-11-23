// The header row paints a file's status and its added/removed counts. Android
// mirrors the row in a right-to-left interface, and each count is its own run
// whose leading sign is a neutral — without a left-to-right isolate the RTL
// paragraph takes the sign and `+3` paints as `3+`, so the pair reads backwards.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ProviderPrFileStatus } from '@kilocode/app-shared/provider-review';

import { i18n } from '@/i18n';
import { openExternalUrl } from '@/lib/external-link';
import { FileHeaderRow, type FileViewedToggle, PatchMissingRow } from './pr-diff-file-rows';
import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

const i18nManager = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', async () => {
  // A `vi.mock` factory runs before this file's imports are initialised, so the
  // shared flatten comes in dynamically; a static import would be unbound here.
  // The shared `Text` reads a caller's own base direction through
  // `StyleSheet.flatten` (`pinsTextDirection`), and the provider link's colour
  // is a caller style, so this stub must flatten.
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
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Eye: 'Eye',
  EyeOff: 'EyeOff',
  File: 'File',
  FileMinus: 'FileMinus',
  FilePlus: 'FilePlus',
  Info: 'Info',
  Link2: 'Link2',
}));
vi.mock('@/lib/a11y/selectable-row', () => ({
  selectableRowA11y: () => ({ accessibilityRole: 'button', accessibilityState: {} }),
}));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888', info: '#0000ff', foreground: '#000000' }),
}));

const ADDITIONS_RUN = `${LTR_ISOLATE_OPEN}+3${LTR_ISOLATE_CLOSE}`;
const DELETIONS_RUN = `${LTR_ISOLATE_OPEN}-1${LTR_ISOLATE_CLOSE}`;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  i18nManager.isRTL = false;
  vi.mocked(openExternalUrl).mockClear();
});

/** The host `Text` nodes, whose children are the strings the row paints. */
function hostTexts(): TestRenderer.ReactTestInstance[] {
  if (!renderer) {
    throw new Error('the row did not render');
  }
  return renderer.root.findAll(
    node => Object.is(node.type, 'Text') && typeof node.props.children === 'string'
  );
}

/** The host icon nodes, plus every host node carrying an accessibility role. */
function hasHostNode(type: string): boolean {
  return (renderer?.root.findAll(node => Object.is(node.type, type)) ?? []).length > 0;
}

function roleHosts(): TestRenderer.ReactTestInstance[] {
  return (
    renderer?.root.findAll(
      node => typeof node.type === 'string' && node.props.accessibilityRole !== undefined
    ) ?? []
  );
}

function mountRow(status: ProviderPrFileStatus = 'modified'): void {
  i18nManager.isRTL = true;
  act(() => {
    renderer = TestRenderer.create(
      createElement(FileHeaderRow, {
        file: {
          path: 'src/greeting.ts',
          previousPath: null,
          status,
          additions: 3,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-export const greeting = "Hi";\n+export const greeting = "Hello";',
          patchMissingCause: null,
        },
        expanded: false,
        hasDiff: true,
        viewedToggle: null,
        onToggleExpand: () => undefined,
      })
    );
  });
}

describe('FileHeaderRow diff stats under an RTL interface', () => {
  it('keeps each signed count in its own isolated left-to-right run', () => {
    mountRow();
    const hosts = hostTexts();
    const additions = hosts.find(node => node.props.children === ADDITIONS_RUN);
    const deletions = hosts.find(node => node.props.children === DELETIONS_RUN);

    expect(additions).toBeDefined();
    expect(deletions).toBeDefined();
  });

  it('keeps each count muted and at the small row size', () => {
    mountRow();
    const hosts = hostTexts();
    for (const run of [ADDITIONS_RUN, DELETIONS_RUN]) {
      const host = hosts.find(node => node.props.children === run);
      expect(host?.props.className).toContain('text-muted-foreground');
      expect(host?.props.className).toContain('text-xs');
    }
  });
});

/**
 * Each status paints from its own key. A mode-only change and an edited file
 * are different statuses, so their labels must differ; before this change the
 * catalog gave both the same word.
 */
describe('FileHeaderRow status label in French', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('paints the changed and the modified status with different labels', async () => {
    await i18n.changeLanguage('fr');

    mountRow('modified');
    const modified = i18n.t('prReview.fileStatus.modified');
    expect(hostTexts().some(node => node.props.children === modified)).toBe(true);
    act(() => renderer?.unmount());

    mountRow('changed');
    const changed = i18n.t('prReview.fileStatus.changed');
    expect(changed).not.toBe(modified);
    expect(hostTexts().some(node => node.props.children === changed)).toBe(true);
  });
});

describe('FileHeaderRow status label in Lithuanian', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('paints the changed and the modified status with different labels', async () => {
    await i18n.changeLanguage('lt');

    mountRow('modified');
    const modified = i18n.t('prReview.fileStatus.modified');
    expect(hostTexts().some(node => node.props.children === modified)).toBe(true);
    act(() => renderer?.unmount());

    mountRow('changed');
    const changed = i18n.t('prReview.fileStatus.changed');
    expect(changed).not.toBe(modified);
    expect(hostTexts().some(node => node.props.children === changed)).toBe(true);
  });
});

/**
 * A file whose patch is absent always shows its notice and cannot collapse, so
 * an expand control there would be a dead button beside an empty caret slot.
 */
describe('FileHeaderRow expand control', () => {
  function mountHeader(hasDiff: boolean, viewedToggle: FileViewedToggle): void {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FileHeaderRow, {
          file: {
            path: 'src/greeting.ts',
            previousPath: null,
            status: 'modified',
            additions: 3,
            deletions: 1,
            patch: null,
            patchMissingCause: 'binary',
          },
          expanded: false,
          hasDiff,
          viewedToggle,
          onToggleExpand: () => undefined,
        })
      );
    });
  }

  it('renders no expand control at all when the file has no patch', () => {
    mountHeader(false, null);

    expect(hasHostNode('ChevronDown')).toBe(false);
    expect(hasHostNode('ChevronUp')).toBe(false);
    // No role anywhere: the dead button is gone, not merely disabled.
    expect(roleHosts()).toHaveLength(0);
    // The path still paints once — removing the slot must not drop the label.
    const paths = hostTexts()
      .map(node => node.props.children as string)
      .filter(text => text.includes('src/greeting.ts'));
    expect(paths).toHaveLength(1);
  });

  it('keeps only the mark-viewed toggle pressable on a patch-less row', () => {
    mountHeader(false, { viewed: false, handleToggle: () => undefined });

    const roles = roleHosts();
    expect(roles).toHaveLength(1);
    expect(roles[0]?.props.accessibilityRole).toBe('button');
  });

  it('keeps a collapsible row expandable through its Pressable', () => {
    mountHeader(true, null);

    const expand = renderer?.root.find(
      node => Object.is(node.type, 'Pressable') && node.props.accessibilityRole === 'button'
    );
    expect(expand?.props.accessibilityState).toEqual({ expanded: false, disabled: false });
    expect(renderer?.root.findAll(node => Object.is(node.type, 'ChevronDown')).length).toBe(1);
  });
});

type PatchMissingFile = Parameters<typeof PatchMissingRow>[0]['file'];

function patchlessFile(patchMissingCause: PatchMissingFile['patchMissingCause']): PatchMissingFile {
  return {
    path: 'assets/photo.png',
    previousPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch: null,
    patchMissingCause,
  };
}

function mountPatchlessRow(
  patchMissingCause: PatchMissingFile['patchMissingCause'],
  link: Parameters<typeof PatchMissingRow>[0]['link'] = null
): void {
  act(() => {
    renderer = TestRenderer.create(
      createElement(PatchMissingRow, {
        file: patchlessFile(patchMissingCause),
        link,
      })
    );
  });
}

/**
 * Every reason a patch can be absent has its own sentence: a binary file, an
 * oversized diff and a provider that never sends diffs are three different
 * answers, and a file whose patch parsed to nothing is a fourth.
 */
describe('PatchMissingRow causes', () => {
  it.each([
    ['too_large', 'prReview.fileRows.diffTooLarge'],
    ['binary', 'prReview.fileRows.binaryDiff'],
    ['provider_omitted', 'prReview.fileRows.diffUnavailable'],
    ['content_unchanged', 'prReview.fileRows.contentUnchanged'],
    [null, 'prReview.fileRows.noPreview'],
  ] as const)('paints %s from its own key', (cause, key) => {
    mountPatchlessRow(cause);
    const copy = i18n.t(key);
    expect(hostTexts().some(node => node.props.children === copy)).toBe(true);
  });
});

/**
 * The card sits directly under a file header row that already paints the path
 * and carries the mark-viewed toggle, so it repeats neither: the one card-level
 * control is the provider link.
 */
describe('PatchMissingRow repeats nothing from the file row above', () => {
  it('paints the cause without the file path', () => {
    mountPatchlessRow('binary');
    const path = patchlessFile('binary').path;
    // The row isolates the path's direction when it paints it, so the check is
    // for the path inside whichever run holds it, not for the bare string.
    const texts = hostTexts()
      .map(node => node.props.children)
      .filter((children): children is string => typeof children === 'string');
    expect(texts.filter(text => text.includes(path))).toEqual([]);
  });

  it('carries an info icon, not a second file icon', () => {
    mountPatchlessRow('binary');

    expect(hasHostNode('Info')).toBe(true);
    expect(hasHostNode('File')).toBe(false);
  });
});

describe('PatchMissingRow provider link', () => {
  it('names GitLab and opens its diff page', () => {
    const url = 'https://gitlab.example.com/group/sub/repo/-/merge_requests/12/diffs';
    mountPatchlessRow('provider_omitted', { url, provider: 'gitlab' });

    expect(
      hostTexts().some(
        node =>
          node.props.children === i18n.t('prReview.fileRows.openOnProvider', { provider: 'GitLab' })
      )
    ).toBe(true);
    const linkNode = renderer?.root.find(
      node => Object.is(node.type, 'Pressable') && node.props.accessibilityRole === 'link'
    );
    expect(linkNode?.props.accessibilityLabel).toBe(
      i18n.t('prReview.fileRows.openDiffOnProvider', { provider: 'GitLab' })
    );
    const onPress = (linkNode?.props as { onPress: () => void } | undefined)?.onPress;
    act(() => {
      onPress?.();
    });
    expect(openExternalUrl).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        label: i18n.t('prReview.fileRows.providerDiff', { provider: 'GitLab' }),
      })
    );
  });

  it('renders no link when the surface has no provider URL', () => {
    mountPatchlessRow('too_large');
    expect(
      renderer?.root.findAll(
        node => Object.is(node.type, 'Pressable') && node.props.accessibilityRole === 'link'
      )
    ).toHaveLength(0);
  });
});
