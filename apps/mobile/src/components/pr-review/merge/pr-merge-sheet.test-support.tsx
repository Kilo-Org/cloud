import { state } from './pr-merge-sheet.test-mocks';
import { createRef } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import '@/i18n';
import { PrMergeSheet } from './pr-merge-sheet';
import { resetDraftTimersForTests } from '@/lib/persist/drafts';
import { __resetMergePartialSuccessStoreForTests } from '@/lib/pr-review/merge/merge-result-banner-store';

export { state };

export type SheetProps = Parameters<typeof PrMergeSheet>[0];
export const baseProps: SheetProps = {
  owner: 'octocat',
  repoName: 'hello',
  number: 1,
  headSha: 'a'.repeat(40),
  isCrossRepo: false,
  prNodeId: 'pr-node-1',
  title: 'Feature',
  bodyMarkdown: null,
  repo: {
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: true,
    allowAutoMerge: true,
    deleteBranchOnMerge: true,
    allowUpdateBranch: true,
    viewerCanPush: true,
    viewerCanAdmin: true,
  },
  initialMethod: 'squash',
  mode: 'merge',
  sheetTitle: 'Merge pull request',
  eyebrow: 'octocat/hello#1',
  onRefetch: vi.fn<() => Promise<void>>(),
  onDismiss: vi.fn<() => void>(),
};
export const mergeResult = { merged: true, sha: 'merged-sha', branchDeleted: true };
export const draftKey = 'pr-merge:octocat/hello#1';
const mounted = new Set<ReactTestRenderer>();

beforeEach(() => {
  resetDraftTimersForTests();
  vi.clearAllMocks();
  state.rows.clear();
  state.identity = { userId: 'u1', isLoading: false };
  state.merge.isPending = false;
  state.merge.error = null;
  state.merge.mutateAsync.mockReset().mockResolvedValue(mergeResult);
  state.autoMerge.isPending = false;
  state.autoMerge.error = null;
  state.autoMerge.mutateAsync.mockReset().mockResolvedValue({});
  state.getItem
    .mockReset()
    .mockImplementation((scope, key) =>
      Promise.resolve(state.rows.get(`${scope}\u0000${key}`) ?? null)
    );
  vi.mocked(baseProps.onRefetch).mockReset().mockResolvedValue(undefined);
  __resetMergePartialSuccessStoreForTests();
});
afterEach(async () => {
  await act(() => {
    for (const renderer of mounted) {
      renderer.unmount();
    }
  });
  mounted.clear();
  resetDraftTimersForTests();
  vi.useRealTimers();
});

export function mountPending(props: Partial<SheetProps> = {}) {
  const instance = createRef<ReactTestRenderer>();
  act(() => {
    instance.current = TestRenderer.create(<PrMergeSheet {...baseProps} {...props} />);
  });
  const renderer = instance.current;
  if (!renderer) {
    throw new Error('Merge sheet did not mount');
  }
  mounted.add(renderer);
  return renderer;
}
export async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
export async function mount(props: Partial<SheetProps> = {}) {
  const renderer = mountPending(props);
  await settle();
  return renderer;
}
export async function update(renderer: ReactTestRenderer, props: Partial<SheetProps> = {}) {
  await act(() => {
    renderer.update(<PrMergeSheet {...baseProps} {...props} />);
  });
}
export async function unmount(renderer: ReactTestRenderer) {
  await act(() => {
    renderer.unmount();
  });
  mounted.delete(renderer);
}
export function hosts(renderer: ReactTestRenderer, type: string) {
  return renderer.root.findAll(node => node.type === type);
}
export function input(renderer: ReactTestRenderer, label: string) {
  const found = hosts(renderer, 'TextInput').find(node => node.props.accessibilityLabel === label);
  if (!found) {
    throw new Error(`Input ${label} missing`);
  }
  return found;
}
export function button(renderer: ReactTestRenderer, label: string) {
  const found = hosts(renderer, 'Button').find(node => node.props.accessibilityLabel === label);
  if (!found) {
    throw new Error(`Button ${label} missing`);
  }
  return found;
}
export async function press(renderer: ReactTestRenderer, label: string) {
  const target = button(renderer, label);
  if (target.props.disabled) {
    throw new Error(`Button ${label} disabled`);
  }
  await act(() => {
    (target.props.onPress as () => void)();
  });
}
export async function edit(renderer: ReactTestRenderer, label: string, text: string) {
  await act(() => {
    (input(renderer, label).props.onChangeText as (value: string) => void)(text);
  });
}
export async function submit(renderer: ReactTestRenderer, label = 'Merge') {
  await press(renderer, label);
  await press(renderer, `Confirm ${label}`);
}
export function seedDraft(
  userId: string,
  entityKey: string,
  value: { title: string; message: string }
) {
  state.rows.set(`draft:${userId}\u0000${entityKey}`, JSON.stringify(value));
}
export function storedDraft(userId = 'u1', entityKey = draftKey) {
  const raw = state.rows.get(`draft:${userId}\u0000${entityKey}`);
  return raw ? (JSON.parse(raw) as { title: string; message: string }) : null;
}
export function visibleText(renderer: ReactTestRenderer): string {
  return (
    hosts(renderer, 'Text')
      // eslint-disable-next-line anti-slop/no-runtime-typeof -- renderer children are a known string-or-node union
      .map(node => node.children.filter(child => typeof child === 'string').join(''))
      .join('\n')
  );
}
export function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}
