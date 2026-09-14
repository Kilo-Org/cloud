/* eslint-disable max-lines -- the state suites share one mock harness in this file */
import { createElement, Fragment, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { TranscriptionModelPickerSheet } from '@/components/transcription-model-picker-sheet';
import {
  readGatewayTranscriptionModel,
  writeGatewayTranscriptionModel,
} from '@/lib/voice-input/gateway/gateway-transcription-preference';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const routerBack = vi.hoisted(() => vi.fn());
const secureStore = vi.hoisted(() => {
  const map = new Map<string, string>();
  // While held, every getItemAsync call returns a pending promise, so a
  // freshly-created preference store sits in its pre-load state (the real
  // SecureStore read resolves after mount). `release` settles them.
  let held = 0;
  const pending: { key: string; resolve: (raw: string | null) => void }[] = [];
  return {
    map,
    hold: () => {
      held += 1;
    },
    release: () => {
      held = Math.max(0, held - 1);
      if (held === 0) {
        for (const entry of pending.splice(0)) {
          entry.resolve(map.get(entry.key) ?? null);
        }
      }
    },
    // The union return is deliberate: a held read stays pending until
    // `release` settles it, an unheld read answers from the map synchronously.
    getItemAsync: (key: string): Promise<string | null> | string | null =>
      held > 0
        ? new Promise<string | null>(resolve => {
            pending.push({ key, resolve });
          })
        : (map.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      map.set(key, value);
    },
    deleteItemAsync: (key: string) => {
      map.delete(key);
    },
  };
});

type HookState = {
  models: { id: string; name: string }[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
};

const hookState = vi.hoisted(() => {
  const current: HookState = {
    models: [],
    isLoading: true,
    isError: false,
    error: null,
    refetch: vi.fn<() => void>(),
  };
  return { current };
});
const hookArgs = vi.hoisted(() => ({ organizationId: undefined as string | undefined }));
vi.mock('@/lib/hooks/use-transcription-models', () => ({
  useTranscriptionModels: (organizationId?: string) => {
    hookArgs.organizationId = organizationId;
    return hookState.current;
  },
}));

const orgState = vi.hoisted(() => ({ organizationId: 'org-1' as string | null }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: orgState.organizationId, isLoaded: true }),
}));

const MODELS = [
  { id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' },
];

function setHookState(patch: Partial<HookState>): void {
  hookState.current = { ...hookState.current, ...patch };
}

// FlatList renders through a callback, so a host-string mock would drop every
// row. This mock calls the render props so the row assertions still see rows
// (same pattern as language-picker-sheet.mounted.test.tsx).
const flatListMock = vi.hoisted(
  () =>
    ({
      data,
      renderItem,
      keyExtractor,
      ListFooterComponent,
    }: {
      data: readonly unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      keyExtractor: (item: unknown, index: number) => string;
      ListFooterComponent?: ReactNode;
    }) => {
      const rows = data.map((item, index) =>
        createElement(Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index }))
      );
      return createElement('FlatList', null, ...rows, ListFooterComponent);
    }
);
vi.mock('react-native', () => ({
  FlatList: flatListMock,
  View: 'View',
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBack, push: vi.fn() }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-secure-store', () => secureStore);
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/picker-sheet', () => ({
  PickerSheet: (props: { children?: ReactNode }) =>
    createElement('PickerSheet', props, props.children),
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => typeof node.type === 'string' && node.type === type);
}

async function mountSheet(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(TranscriptionModelPickerSheet));
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function mountPickerSheetProps(renderer: TestRenderer.ReactTestRenderer) {
  const sheet = findByType(renderer.root, 'PickerSheet')[0];
  if (!sheet) {
    throw new Error('PickerSheet not found');
  }
  return sheet.props as { title: string; onDone: () => void; onCancel: () => void };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TranscriptionModelPickerSheet', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    routerBack.mockClear();
    secureStore.map.clear();
    writeGatewayTranscriptionModel(null);
    orgState.organizationId = 'org-1';
    hookArgs.organizationId = undefined;
    setHookState({
      models: [],
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn<() => void>(),
    });
  });

  afterEach(() => {
    writeGatewayTranscriptionModel(null);
  });

  it('renders the sheet with the transcription model title', async () => {
    const renderer = await mountSheet();
    expect(mountPickerSheetProps(renderer).title).toBe('Transcription model');
    renderer.unmount();
  });

  it('scopes the model catalogue read to the selected organization', async () => {
    orgState.organizationId = 'org-42';
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();

    expect(hookArgs.organizationId).toBe('org-42');
    renderer.unmount();
  });

  it('reads the catalogue unscoped for a personal account', async () => {
    orgState.organizationId = null;
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();

    expect(hookArgs.organizationId).toBeUndefined();
    renderer.unmount();
  });

  it('shows six skeleton rows sized like real rows while loading', async () => {
    const renderer = await mountSheet();

    // 6 rows × (name line + id caption): no trailing control, because the
    // loaded row's check is transparent unless selected.
    const skeletons = findByType(renderer.root, 'Skeleton');
    expect(skeletons).toHaveLength(12);
    // Each skeleton sits in a row reserved at the real row's height
    // (min-h-11 + py-3), so loading → rows never jumps layout.
    const skeletonRows = findByType(renderer.root, 'View').filter(
      node =>
        typeof node.props.className === 'string' &&
        node.props.className.includes('min-h-11') &&
        node.props.className.includes('py-3')
    );
    expect(skeletonRows).toHaveLength(6);
    expect(skeletonRows[0]?.props.className).toContain('items-center justify-between');
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);
    expect(findByType(renderer.root, 'EmptyState')).toHaveLength(0);

    renderer.unmount();
  });

  it('shows the error state with a working retry when the load fails', async () => {
    const refetch = vi.fn<() => void>();
    setHookState({ isLoading: false, isError: true, error: new Error('boom'), refetch });
    const renderer = await mountSheet();

    const errorState = findByType(renderer.root, 'QueryError')[0];
    if (!errorState) {
      throw new Error('QueryError not found');
    }
    expect(errorState.props.title).toBe("Couldn't load transcription models.");
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(0);

    act(() => {
      (errorState.props.onRetry as () => void)();
    });
    expect(refetch).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('shows the empty state when the gateway offers no models', async () => {
    setHookState({ isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();

    const emptyState = findByType(renderer.root, 'EmptyState')[0];
    expect(emptyState?.props).toMatchObject({
      icon: 'Mic',
      title: 'No transcription models',
      description: 'The gateway offers no transcription models right now.',
    });
    expect(findByType(renderer.root, 'FlatList')).toHaveLength(0);

    renderer.unmount();
  });

  it('renders rows with model name and id caption, marking the stored model', async () => {
    writeGatewayTranscriptionModel({ id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' });
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();

    const rows = findByType(renderer.root, 'ChoiceRow');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.props).toMatchObject({
      label: 'Whisper Large v3',
      description: 'kilo/whisper-large-v3',
      selected: true,
    });
    expect(rows[1]?.props).toMatchObject({
      label: 'GPT-4o Mini Transcribe',
      description: 'openai/gpt-4o-mini-transcribe',
      selected: false,
    });
    expect(findByType(renderer.root, 'Skeleton')).toHaveLength(0);

    renderer.unmount();
  });

  it('holds the skeletons until the stored-model read settles, then marks the current model', async () => {
    // A cold start races the models query against the SecureStore read: with
    // the read still pending the store reports "no choice", which would draw
    // every loaded row unchecked (e2-picker spot defect). The sheet holds the
    // skeleton state until the read settles, so the rows render once, with
    // the correct check.
    secureStore.map.set(
      'gateway-transcription-model',
      JSON.stringify({ id: 'kilo/whisper-large-v3', name: 'Whisper Large v3' })
    );
    secureStore.hold();
    try {
      // A fresh preference store: its initial SecureStore read is the held one.
      vi.resetModules();
      const { TranscriptionModelPickerSheet: ColdStartSheet } =
        await import('@/components/transcription-model-picker-sheet');
      setHookState({ models: MODELS, isLoading: false, isError: false, error: null });

      const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
      await act(async () => {
        ref.current = TestRenderer.create(createElement(ColdStartSheet));
        await Promise.resolve();
      });
      const coldRenderer = ref.current;
      if (!coldRenderer) {
        throw new Error('renderer was not created');
      }

      // Models are loaded but the store read is pending: skeletons hold and
      // no row renders unchecked.
      expect(findByType(coldRenderer.root, 'Skeleton')).toHaveLength(12);
      expect(findByType(coldRenderer.root, 'ChoiceRow')).toHaveLength(0);

      secureStore.release();
      await act(async () => {
        await Promise.resolve();
      });

      const rows = findByType(coldRenderer.root, 'ChoiceRow');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.props).toMatchObject({ label: 'Whisper Large v3', selected: true });
      expect(findByType(coldRenderer.root, 'Skeleton')).toHaveLength(0);

      coldRenderer.unmount();
    } finally {
      secureStore.release();
      vi.resetModules();
    }
  });

  it('persists the tapped model to the store and dismisses the sheet', async () => {
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();

    const row = findByType(renderer.root, 'ChoiceRow').find(
      item => item.props.label === 'GPT-4o Mini Transcribe'
    );
    if (!row) {
      throw new Error('row not found');
    }
    act(() => {
      (row.props.onPress as () => void)();
    });

    expect(readGatewayTranscriptionModel()).toEqual({
      id: 'openai/gpt-4o-mini-transcribe',
      name: 'GPT-4o Mini Transcribe',
    });
    expect(secureStore.map.get('gateway-transcription-model')).toBe(
      JSON.stringify({ id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' })
    );
    expect(routerBack).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it('keeps the rows on screen when a refetch fails', async () => {
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();
    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(2);

    // A refresh that fails leaves the loaded data in place: the error state
    // never blanks rows the user can still pick from.
    setHookState({ isError: true, error: new Error('boom') });
    await act(async () => {
      renderer.update(createElement(TranscriptionModelPickerSheet));
      await Promise.resolve();
    });

    expect(findByType(renderer.root, 'ChoiceRow')).toHaveLength(2);
    expect(findByType(renderer.root, 'QueryError')).toHaveLength(0);

    renderer.unmount();
  });

  it('dismisses from the header Done and Cancel controls without writing', async () => {
    setHookState({ models: MODELS, isLoading: false, isError: false, error: null });
    const renderer = await mountSheet();
    const props = mountPickerSheetProps(renderer);

    act(() => {
      props.onDone();
    });
    expect(routerBack).toHaveBeenCalledTimes(1);
    expect(readGatewayTranscriptionModel()).toBeNull();

    act(() => {
      props.onCancel();
    });
    expect(routerBack).toHaveBeenCalledTimes(2);

    renderer.unmount();
  });
});
