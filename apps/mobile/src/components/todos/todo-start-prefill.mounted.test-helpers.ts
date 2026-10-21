import { type ReactNode } from 'react';
import { vi } from 'vitest';

import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type TodoItem, type TodoList } from '@/lib/todos/todo-types';

type Handoff = {
  organizationId: string | null;
  params: Record<string, string>;
  lists: TodoList[];
  items: TodoItem[];
  models: ModelOption[];
  repositories: { platform: string; fullName: string }[];
  reposSettled: boolean;
  toastInfo: ReturnType<typeof vi.fn>;
};

const handoff: Handoff = vi.hoisted(
  (): Handoff => ({
    organizationId: null,
    params: {},
    lists: [],
    items: [],
    models: [],
    repositories: [],
    reposSettled: false,
    toastInfo: vi.fn(),
  })
);

export function getHandoff() {
  return handoff;
}

// Vitest hoists mock factories before static React imports initialize.
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  const router = {
    push: (href: string) => {
      handoff.params = Object.fromEntries(new URL(href, 'https://router.test').searchParams);
    },
    canGoBack: () => false,
  };
  return {
    useRouter: () => router,
    useLocalSearchParams: () => handoff.params,
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      useEffect(effect, [effect]);
    },
  };
});
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Platform: { OS: 'android', select: (values: { android?: unknown }) => values.android },
  StyleSheet: { flatten: (style: unknown) => style, create: (style: unknown) => style },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1, scale: 1 }),
  useColorScheme: () => 'light',
}));
vi.mock('nativewind', () => ({ styled: (component: unknown) => component }));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Text', Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => {
  const names = [
    'AlertCircle',
    'ArrowLeft',
    'ArrowRight',
    'Bot',
    'Bug',
    'Check',
    'ChevronDown',
    'ChevronLeft',
    'ChevronRight',
    'Circle',
    'CircleCheck',
    'CircleDot',
    'Code',
    'GitPullRequest',
    'HelpCircle',
    'Loader2',
    'Lock',
    'NotebookPen',
    'Play',
    'Plus',
    'RotateCcw',
    'SearchX',
    'ServerCrash',
    'Settings2',
    'Trash2',
    'WifiOff',
    'Workflow',
  ] as const;
  return Object.fromEntries(names.map(name => [name, name]));
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: { View: 'View', ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    makeMutable: (value: unknown) => ({ value }),
    cancelAnimation: vi.fn(),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
    Easing: { inOut: (value: unknown) => value, ease: 0 },
    useReducedMotion: () => true,
    ReducedMotionConfig: 'ReducedMotionConfig',
    ReduceMotion: { System: 0, Always: 1 },
  };
});
vi.mock('react-native-sortables', async () => {
  const { createElement, Fragment } = await import('react');
  return {
    default: {
      Touchable: 'SortableTouchable',
      Grid: ({
        data,
        renderItem,
      }: {
        data: TodoItem[];
        renderItem: (info: { item: TodoItem; index: number }) => ReactNode;
      }) =>
        data.map((item, index) =>
          createElement(Fragment, { key: item.id }, renderItem({ item, index }))
        ),
    },
  };
});
vi.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({
  default: 'Swipeable',
  SwipeDirection: { RIGHT: 'right', LEFT: 'left' },
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-battery', () => ({ BatteryState: {} }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('sonner-native', () => ({
  toast: { info: handoff.toastInfo, error: vi.fn() },
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: handoff.organizationId }),
}));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}), trpcClient: {} }));
vi.mock('@/lib/app-actions/start-agent', () => ({ startAgent: vi.fn() }));
vi.mock('@/lib/hooks/use-todos', () => ({
  PENDING_TODO_ID_PREFIX: 'pending:',
  useTodoLists: () => ({ data: handoff.lists, isSuccess: true, isPending: false }),
  useTodoItems: () => ({ data: handoff.items, isPending: false, isError: false }),
  useTodoItemMutations: () => ({
    create: { mutate: vi.fn() },
    update: { mutate: vi.fn() },
    move: { mutate: vi.fn() },
    removeWithUndo: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-available-models', () => ({
  useAvailableModels: () => ({ models: handoff.models }),
  useOrgDefaultModel: () => ({ defaultModel: undefined, isLoading: false }),
}));
vi.mock('@/lib/hooks/use-model-preferences', () => ({
  useModelPreferences: () => ({
    lastSelected: { model: 'provider/usual-model', variant: 'low' },
    isLoading: false,
  }),
}));
vi.mock('@/lib/hooks/use-persisted-agent-model', () => ({
  usePersistedAgentModel: () => ({ stored: {}, hasLoaded: true }),
}));

export const savedList = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: null,
  name: 'Release checklist',
  emoji: null,
  gitUrl: 'saved/repository',
  mode: 'plan',
  model: 'provider/list-model',
  variant: 'high',
  position: 'a0',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  openCount: 1,
} satisfies TodoList;

export const todo = {
  id: '22222222-2222-4222-8222-222222222222',
  listId: savedList.id,
  title: 'Review search & filters',
  notes: ' Keep the query when returning.\nCover empty results. ',
  doneAt: null,
  position: 'a0',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessions: [],
} satisfies TodoItem;

export function loadTargets() {
  handoff.models = [
    {
      id: 'provider/usual-model',
      name: 'Usual model',
      variants: ['low', 'high'],
      isPreferred: true,
    },
    {
      id: 'provider/list-model',
      name: 'List model',
      variants: ['low', 'high'],
      isPreferred: false,
    },
  ];
  handoff.repositories = [
    { platform: 'gitlab', fullName: 'Saved/Repository' },
    { platform: 'github', fullName: 'Saved/Repository' },
    { platform: 'github', fullName: 'Other/Repository' },
  ];
  handoff.reposSettled = true;
}
