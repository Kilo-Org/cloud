// The entry screen is the first route into a review for every provider
// (s7): the field must accept a GitHub PR, a GitLab MR (gitlab.com or a
// self-managed host) and a Bitbucket PR. The URL-field arm of the tests;
// the recents arm lives in pr-review-entry-recents.test.ts and the shared
// plain-function-call harness in pr-review-entry-screen-test-utils.ts.

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
  it('labels and placeholders name both review nouns, no provider host', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
    expect(input.props?.placeholder).toBe('Pull request or merge request URL');
    expect(input.props?.accessibilityLabel).toBe('Enter a pull request or merge request URL');
    expect(String(input.props?.placeholder)).not.toContain('github');
  });

  it('opens a GitHub PR URL on the GitHub route', async () => {
    const tree = await renderLoaded();
    const input = find(tree, 'TextInput', () => true);
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
    const input = find(tree, 'TextInput', () => true);
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
    const input = find(tree, 'TextInput', () => true);
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
    const input = find(tree, 'TextInput', () => true);
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
    const input = find(before, 'TextInput', () => true);
    (propsOf(input).onChangeText as (value: string) => void)('anything');
    const after = render();
    expect(find(after, 'Pressable', p => p.accessibilityLabel === 'Clear link')).toBeTruthy();
  });
});
