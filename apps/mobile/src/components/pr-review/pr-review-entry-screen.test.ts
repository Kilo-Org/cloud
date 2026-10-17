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
} from './pr-review-entry-screen-test-utils';

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots();
  mocks.clipboard.current = '';
  seedRecents([]);
});

describe('provider-neutral URL field', () => {
  it('hides the placeholder overlay once the field has text', async () => {
    const before = await renderLoaded();
    expect(findAll(before, 'PrLinkPlaceholder')).toHaveLength(1);
    const input = find(before, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('https://github.com/a/b/pull/1');
    const after = render();
    expect(findAll(after, 'PrLinkPlaceholder')).toHaveLength(0);
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

  it('enables Open only for valid links and clears inline feedback after correction or clear', async () => {
    let tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    const change = propsOf(input).onChangeText as (value: string) => void;
    const openButton = () =>
      find(tree, 'Button', p => p.accessibilityLabel === 'Open pull request or merge request');
    const errors = () =>
      findAll(tree, 'Text').filter(p => p.props?.accessibilityLiveRegion === 'polite');

    expect(propsOf(openButton()).disabled).toBe(true);
    for (const value of ['   ', '\t\n']) {
      change(value);
      tree = render();
      expect(propsOf(openButton()).disabled).toBe(true);
      expect(errors()).toHaveLength(0);
    }
    for (const value of ['not a link', '😀 العربية a\u0301\u202E', 'https://example.com/blog']) {
      change(value);
      tree = render();
      expect(propsOf(openButton()).disabled).toBe(true);
      expect(errors()).toHaveLength(1);
      expect(errors()[0]?.props?.children).toBe('Not a pull request or merge request link');
    }
    change('  https://github.com/octocat/hello-world/pull/42  ');
    tree = render();
    expect(propsOf(openButton()).disabled).toBe(false);
    expect(errors()).toHaveLength(0);
    (propsOf(openButton()).onPress as () => void)();
    expect(mocks.push).toHaveBeenCalledWith('/(app)/pr-review/octocat/hello-world/42');

    change('invalid again');
    tree = render();
    (
      propsOf(find(tree, 'Pressable', p => p.accessibilityLabel === 'Clear link'))
        .onPress as () => void
    )();
    tree = render();
    expect(propsOf(openButton()).disabled).toBe(true);
    expect(errors()).toHaveLength(0);
  });

  it('rejects invalid keyboard submission without navigating', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'Input', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('https://example.com/blog/post');
    (propsOf(input).onSubmitEditing as () => void)();
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
});
