// Mounted regression for the orphaned-findings delete phase (12-12): two
// repositories delete through one mutation instance, so each row owns its own
// busy state and one refusal cannot dim another row.

import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SurfaceFeedbackModule from '@/lib/surface-feedback';

import { i18n } from '@/i18n';
import { act, type TestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { OrphanedFindingsCard } from './orphaned-findings-card';

/** One delete call the transport recorded, with the handle its test settles. */
type DeleteCall = { repoFullName: string; settle: (ok: boolean) => void };

type ConfirmRequest = { onConfirm: () => void };

const world = vi.hoisted(() => ({
  deletes: [] as DeleteCall[],
  confirm: vi.fn<(request: ConfirmRequest) => void>(),
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));

vi.mock('@/components/ui/dialog', () => ({
  useConfirmDialog: () => ({
    confirm: (request: ConfirmRequest) => {
      world.confirm(request);
    },
    dialog: null,
  }),
}));

vi.mock('@/components/ui/icons', () => ({ ShieldAlert: 'ShieldAlert' }));

vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});

vi.mock('@/lib/a11y/tap-target', () => ({
  LINE_ACTION_BOX_CLASS: 'action-box',
  LINE_ACTION_HIT_SLOP: 8,
}));

vi.mock('@/lib/format', () => ({ formatNumber: String }));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));

vi.mock('@/lib/hooks/use-security-orphaned-findings', () => ({
  useOrphanedRepositories: () => ({
    data: [
      { repoFullName: 'acme/one', findingCount: 3 },
      { repoFullName: 'acme/two', findingCount: 5 },
    ],
  }),
  useDeleteFindingsByRepository: () => ({
    mutateAsync: (repoFullName: string) =>
      new Promise((resolve, reject) => {
        world.deletes.push({
          repoFullName,
          settle: (ok: boolean) => {
            if (ok) {
              resolve({ deletedCount: 3 });
              return;
            }
            reject(new Error('The delete failed.'));
          },
        });
      }),
  }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));

/** The one part of a surface store a case can read from outside the card. */
type RecordedSnapshot = { readonly states: ReadonlyMap<string, unknown> };
type RecordedStore = { getSnapshot: () => RecordedSnapshot };

/** Every surface store the adapters created, so a case can see what a settle left. */
const stores = vi.hoisted(() => ({ all: [] as RecordedStore[] }));

vi.mock('@/lib/surface-feedback', async importOriginal => {
  const actual = await importOriginal<typeof SurfaceFeedbackModule>();
  return {
    ...actual,
    createSurfaceFeedbackStore: () => {
      const created: RecordedStore = actual.createSurfaceFeedbackStore();
      stores.all.push(created);
      return created;
    },
  };
});

/** The Clear control of one repository row. */
function clearButton(renderer: TestRenderer.ReactTestRenderer, repoFullName: string) {
  const label = i18n.t('securityAgent.orphanedFindings.clearLabel', { repository: repoFullName });
  const found = renderer.root.findAll(node => node.props.accessibilityLabel === label)[0];
  if (!found) {
    throw new Error(`no Clear control for ${repoFullName}`);
  }
  return found;
}

/** Whether each row's Clear control is disabled, in render order. */
function disabledStates(renderer: TestRenderer.ReactTestRenderer): boolean[] {
  return ['acme/one', 'acme/two'].map(repo => clearButton(renderer, repo).props.disabled === true);
}

/** Presses Clear for a repository, then accepts the confirmation. */
async function confirmClear(renderer: TestRenderer.ReactTestRenderer, repoFullName: string) {
  const press = clearButton(renderer, repoFullName).props.onPress;
  if (typeof press !== 'function') {
    throw new TypeError('the Clear control has no press handler');
  }
  act(() => {
    (press as () => void)();
  });
  const request = world.confirm.mock.calls.at(-1)?.[0];
  if (!request) {
    throw new Error('the delete confirmation was not requested');
  }
  await act(async () => {
    request.onConfirm();
    await Promise.resolve();
  });
}

beforeEach(() => {
  world.deletes.length = 0;
  world.confirm.mockReset();
  stores.all.length = 0;
});

describe('OrphanedFindingsCard delete phase', () => {
  it('a failed delete for one repository does not leave another dimmed', async () => {
    const mounted = await renderWithProviders(
      createElement(OrphanedFindingsCard, { scope: 'org-1', canManage: true })
    );
    const renderer = mounted.renderer;

    await confirmClear(renderer, 'acme/one');
    expect(world.deletes.map(call => call.repoFullName)).toEqual(['acme/one']);
    expect(disabledStates(renderer)).toEqual([true, false]);

    await confirmClear(renderer, 'acme/two');
    expect(world.deletes.map(call => call.repoFullName)).toEqual(['acme/one', 'acme/two']);
    expect(disabledStates(renderer)).toEqual([true, true]);

    // A fails: only A's row goes live again, while B is still deleting.
    await act(async () => {
      world.deletes[0]?.settle(false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(disabledStates(renderer)).toEqual([false, true]);

    await act(async () => {
      world.deletes[1]?.settle(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(disabledStates(renderer)).toEqual([false, false]);

    renderer.unmount();
  });

  it('a failed delete leaves nothing admitted for that repository', async () => {
    const mounted = await renderWithProviders(
      createElement(OrphanedFindingsCard, { scope: 'org-1', canManage: true })
    );
    const renderer = mounted.renderer;

    await confirmClear(renderer, 'acme/one');
    await act(async () => {
      world.deletes[0]?.settle(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The mutation hook's toast names the failure and the row is pressable
    // again, so the store must not keep the refused delete's entry until the
    // card unmounts.
    expect(stores.all.map(store => store.getSnapshot().states.size)).toEqual([0]);
    expect(disabledStates(renderer)).toEqual([false, false]);

    renderer.unmount();
  });
});
