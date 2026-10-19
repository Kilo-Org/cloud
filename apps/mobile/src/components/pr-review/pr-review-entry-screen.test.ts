/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test also reads the entry screen off disk, which is the only place an import-time `Platform` capture is observable */
// The entry screen is the first route into a review for every provider
// (s7): the field must accept a GitHub PR, a GitLab MR (gitlab.com or a
// self-managed host) and a Bitbucket PR. The URL-field arm of the tests;
// the recents arm lives in pr-review-entry-recents.test.ts and the shared
// plain-function-call harness in pr-review-entry-screen-test-utils.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPrLinkFieldDraft } from '@/lib/pr-review/pr-link-field-draft';
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
} from './pr-review-entry-screen-test-utils';

// The field draws the visible placeholder with the same one-line overlay on
// both platforms; a `Platform` symbol in the screen would let one platform
// fork it, so the source is pinned below.
const ENTRY_SCREEN_SOURCE = readFileSync(join(__dirname, 'pr-review-entry-screen.tsx'), 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots();
  clearPrLinkFieldDraft();
  mocks.clipboard.current = '';
  mocks.clipboard.hasString = true;
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

  it('reports denied paste access instead of an empty clipboard', async () => {
    // Denial semantics: the read returns '' while the pasteboard still holds
    // text, so hasStringAsync keeps reporting content. The harness's read spy
    // replaces the mock's module binding, so the clipboard content below is
    // what a successful read would have returned.
    mocks.clipboard.current = 'https://gitlab.com/acme/api/-/merge_requests/3';
    mocks.clipboard.hasString = true;
    const clipboardModule = await import('expo-clipboard');
    const readSpy = vi.spyOn(clipboardModule, 'getStringAsync').mockResolvedValue('');
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    await (propsOf(paste).onPress as () => Promise<void>)();
    await flush();
    readSpy.mockRestore();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Paste access was denied. Allow paste and try again.'
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('Clipboard is empty');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('keeps the empty-clipboard copy for a truly empty clipboard', async () => {
    mocks.clipboard.current = '';
    mocks.clipboard.hasString = false;
    const tree = await renderLoaded();
    const paste = find(
      tree,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    await (propsOf(paste).onPress as () => Promise<void>)();
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith('Clipboard is empty');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('restores the pasted link on the next mount after a cancelled open', async () => {
    // First mount: paste a valid link (screen navigates), then the remount the
    // back gesture produces — resetHookSlots drops all hook state like a fresh
    // mount, and the retained draft must refill the field.
    mocks.clipboard.current = 'https://gitlab.com/acme/api/-/merge_requests/3';
    const first = await renderLoaded();
    const paste = find(
      first,
      'Pressable',
      p => p.accessibilityLabel === 'Paste pull request or merge request link'
    );
    await (propsOf(paste).onPress as () => Promise<void>)();
    await flush();
    resetHookSlots();
    // The restore writes hook state during the mount render; a second render
    // re-reads the slots, like every setter in this harness.
    render();
    const second = render();
    const input = find(second, 'Input', () => true);
    expect(propsOf(input).defaultValue).toBe('');
    // The draft restore runs in the focus effect the harness invokes during
    // render; the field placeholder must be gone and Open re-enabled.
    expect(findAll(second, 'PrLinkPlaceholder')).toHaveLength(0);
    const open = find(
      second,
      'Button',
      p => p.accessibilityLabel === 'Open pull request or merge request'
    );
    const openProps: Record<string, unknown> = propsOf(open);
    expect(openProps.disabled).toBe(false);
  });
});
