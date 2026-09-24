/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test also reads the entry screen off disk, which is the only place an import-time `Platform` capture is observable */
// The entry screen is the first route into a review for every provider
// (s7): the field must accept a GitHub PR, a GitLab MR (gitlab.com or a
// self-managed host) and a Bitbucket PR. The URL-field arm of the tests;
// the recents arm lives in pr-review-entry-recents.test.ts and the shared
// plain-function-call harness in pr-review-entry-screen-test-utils.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  find,
  findAll,
  flush,
  mocks,
  propsOf,
  render,
  renderLoaded,
  resetHookSlots,
  seedRecents,
  textValues,
} from './pr-review-entry-screen-test-utils';

// The field draws the visible placeholder with the same one-line overlay on
// both platforms; a `Platform` symbol in the screen would let one platform
// fork it, so the source is pinned below.
const ENTRY_SCREEN_SOURCE = readFileSync(join(__dirname, 'pr-review-entry-screen.tsx'), 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots();
  mocks.clipboard.current = '';
  seedRecents([]);
});

describe('provider-neutral URL field', () => {
  it('labels and placeholders name both review nouns, no provider host', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    expect(input.props?.placeholder).toBe('Pull request or merge request URL');
    expect(input.props?.accessibilityLabel).toBe('Enter a pull request or merge request URL');
    expect(String(input.props?.placeholder)).not.toContain('github');
  });

  it('draws the placeholder as one ellipsized line instead of the wrapping native hint', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    // pr-review-home finding: at font scale 2 the native EditText lays the long
    // placeholder hint out on two lines while Yoga sizes the field to one line,
    // so the second line is clipped. `numberOfLines` cannot stop that — RN
    // never marks a single-line input as single-line, so the hint still wraps —
    // hence the visible placeholder is the one-line overlay below. The native
    // hint stays set (the device digest binds the field's text and hint to the
    // placeholder copy) but is transparent on both platforms so it cannot draw.
    expect(input.props?.placeholder).toBe('Pull request or merge request URL');
    expect(input.props?.placeholderTextColor).toBe('transparent');
    expect(input.props?.numberOfLines).toBe(1);
    const overlay = find(tree, 'PrLinkPlaceholder', () => true);
    expect(overlay.props?.label).toBe('Pull request or merge request URL');
  });

  it('hides the placeholder overlay once the field has text', async () => {
    const before = await renderLoaded();
    expect(findAll(before, 'PrLinkPlaceholder')).toHaveLength(1);
    const input = find(before, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('https://github.com/a/b/pull/1');
    const after = render();
    expect(findAll(after, 'PrLinkPlaceholder')).toHaveLength(0);
  });

  it('keeps no Platform.OS fork in the entry screen', () => {
    // One implementation for both platforms: the field, its transparent native
    // hint and the one-line overlay render identically on iOS and Android.
    expect(ENTRY_SCREEN_SOURCE).not.toMatch(/\bPlatform\b/);
  });

  it('leaves the field box to the shared input and adds no vertical padding', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    const classes = String(input.props?.className).split(' ');
    // The shared single-line box (`@/components/ui/input`) owns the height floor
    // and the one line box; the call site must not re-add vertical padding or a
    // fixed height, which drew the placeholder off the value's baseline
    // (apps/mobile/AGENTS.md).
    expect(classes).toContain('text-base');
    expect(classes.filter(name => name.startsWith('py-'))).toEqual([]);
    expect(classes.filter(name => /^min-h|^h-\d/.test(name))).toEqual([]);
  });

  it('opens a GitHub PR URL on the GitHub route', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)(
      'https://github.com/octocat/hello-world/pull/42'
    );
    const open = render();
    (
      propsOf(
        find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
      ).onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/octocat/hello-world/42');
  });

  it('opens a self-managed GitLab MR on the provider route with its instance', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)(
      'https://gitlab.example.com/group/sub/repo/-/merge_requests/9'
    );
    const open = render();
    (
      propsOf(
        find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
      ).onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/9?instance=https%3A%2F%2Fgitlab.example.com'
    );
  });

  it('opens a Bitbucket PR on the provider route', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)(
      'https://bitbucket.org/acme/api/pull-requests/7/overview'
    );
    const open = render();
    (
      propsOf(
        find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
      ).onPress as () => void
    )();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/bitbucket/acme/api/7');
  });

  it('toasts the provider-neutral invalid copy for a link no provider serves', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('https://example.com/blog/post');
    const open = render();
    (
      propsOf(
        find(open, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request')
      ).onPress as () => void
    )();
    expect(mocks.toastError).toHaveBeenCalledWith('Not a pull request or merge request link');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('paste replaces the field and opens a GitLab MR straight away', async () => {
    mocks.clipboard.current = 'https://gitlab.com/acme/api/-/merge_requests/3';
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    await (propsOf(paste).onPress as () => Promise<void>)();
    await flush();
    expect(mocks.push).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/acme/api/3?instance=https%3A%2F%2Fgitlab.com'
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('paste of plain text keeps the invalid toast without navigating', async () => {
    mocks.clipboard.current = 'just some notes';
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    await (propsOf(paste).onPress as () => Promise<void>)();
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith('Not a pull request or merge request link');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('shows the clear control only once the field has text', async () => {
    const before = await renderLoaded();
    expect(
      findAll(before, 'Pressable').some(p => p.props?.accessibilityLabel === 'Clear link')
    ).toBe(false);
    const input = find(before, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('anything');
    const after = render();
    expect(find(after, 'Pressable', p => p.accessibilityLabel === 'Clear link')).toBeTruthy();
  });

  it('states the instruction once, in the header eyebrow, not the field caption', async () => {
    const tree = await renderLoaded();
    const header = find(tree, 'ScreenHeader', () => true);
    // Finding: the field's own letter-spaced "Paste a pull request or merge
    // request link" caption repeated the header instruction. The header keeps
    // the single instruction as its eyebrow; the field keeps its placeholder.
    expect(header.props?.title).toBe('PR Review');
    expect(header.props?.eyebrow).toBe('Open a pull request or merge request by URL');
    const input = find(tree, 'TextInput', () => true);
    expect(input.props?.placeholder).toBe('Pull request or merge request URL');
    // The paste block no longer carries a caption repeating the instruction.
    const list = find(tree, 'PrReviewInboxList', () => true);
    const pasteBlockTexts = textValues(propsOf(list).header);
    expect(pasteBlockTexts).not.toContain('Paste a pull request or merge request link');
    expect(pasteBlockTexts).not.toContain('Open a pull request or merge request by URL');
  });
});
