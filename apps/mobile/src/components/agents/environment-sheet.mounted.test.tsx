import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import { type EnvironmentSummaryRow } from '@/lib/cloud-environments/environment-selection';

import { EnvironmentSheet } from './environment-sheet';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/components/ui/sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', mutedForeground: '#666' }),
}));
// The build view owns its own reads and mutations, which its suite covers; this
// sheet suite asserts the navigation between the two views it holds.
vi.mock('./environment-build-detail', () => ({ EnvironmentBuildDetail: 'EnvironmentBuildDetail' }));

const ENVIRONMENT: EnvironmentSummaryRow = {
  id: 'env-1',
  name: 'Mobile parity lab',
  createdAt: '2026-01-01 00:00:00+00',
  updatedAt: '2026-01-01 00:00:00+00',
  plainVarCount: 0,
  secretCount: 0,
  commandCount: 1,
  configurationRevision: 1,
  sandboxAllocation: null,
  repositories: [{ platform: 'github', repoFullName: 'picker-lab/private-repo' }],
};

const OTHER_ENVIRONMENT: EnvironmentSummaryRow = {
  ...ENVIRONMENT,
  id: 'env-2',
  name: 'Broken build lab',
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function renderSheet(overrides: { selectedEnvironmentId?: string | null } = {}) {
  const onChoose = vi.fn<(environmentId: string) => void>();
  const onClose = vi.fn<() => void>();
  const element = (
    <EnvironmentSheet
      visible
      onClose={onClose}
      environments={[ENVIRONMENT, OTHER_ENVIRONMENT]}
      selectedEnvironmentId={overrides.selectedEnvironmentId ?? ENVIRONMENT.id}
      repositoryLabel="picker-lab/private-repo"
      organizationId={undefined}
      buildStatusFor={() => undefined}
      buildStatusFailedFor={() => false}
      onRetryBuildStatus={vi.fn<() => void>()}
      onChoose={onChoose}
    />
  );
  TestRenderer.act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Environment sheet did not mount');
  }
  return { root: renderer.root, onChoose, onClose };
}

function headers(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType('SheetHeader');
}

function buildDetail(root: TestRenderer.ReactTestInstance) {
  return root.findAllByType('EnvironmentBuildDetail')[0] ?? null;
}

function rowPressable(root: TestRenderer.ReactTestInstance, name: string) {
  const [node] = root.findAll(
    candidate =>
      (candidate.type as string) === 'Pressable' &&
      candidate.props.accessibilityLabel === name &&
      candidate.props.accessibilityRole === 'button'
  );
  if (!node) {
    throw new Error(`The row for ${name} did not render a pressable`);
  }
  return node;
}

function pressBuildDetails(root: TestRenderer.ReactTestInstance, environmentId: string) {
  const buildPressables = root.findAll(
    candidate =>
      (candidate.type as string) === 'Pressable' &&
      candidate.props.accessibilityLabel === i18n.t('agentChat.environment.buildDetails')
  );
  const index = environmentId === ENVIRONMENT.id ? 0 : 1;
  const node = buildPressables[index];
  if (!node) {
    throw new Error(`The build control for ${environmentId} did not render`);
  }
  TestRenderer.act(() => {
    (node.props.onPress as () => void)();
  });
}

describe('EnvironmentSheet', () => {
  it('chooses only from a list row press, and closes with it', () => {
    const { root, onChoose, onClose } = renderSheet();

    TestRenderer.act(() => {
      (rowPressable(root, OTHER_ENVIRONMENT.name).props.onPress as () => void)();
    });

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(OTHER_ENVIRONMENT.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Done in the build view without changing the pick', () => {
    const { root, onChoose, onClose } = renderSheet();
    pressBuildDetails(root, OTHER_ENVIRONMENT.id);

    const detail = buildDetail(root);
    expect(detail).not.toBeNull();

    TestRenderer.act(() => {
      (detail?.props.onClose as () => void)();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    // Reading a build's log is not choosing it: the session keeps the
    // environment it already had.
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('returns to the list on Back without changing the pick', () => {
    const { root, onChoose, onClose } = renderSheet();
    pressBuildDetails(root, OTHER_ENVIRONMENT.id);

    TestRenderer.act(() => {
      (buildDetail(root)?.props.onBack as () => void)();
    });

    expect(buildDetail(root)).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(rowPressable(root, ENVIRONMENT.name)).toBeDefined();
  });

  it('closes on Done in the list without changing the pick', () => {
    const { root, onChoose, onClose } = renderSheet();

    const [listHeader] = headers(root);
    if (!listHeader) {
      throw new Error('The list header did not render');
    }
    TestRenderer.act(() => {
      (listHeader.props.onDone as () => void)();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });
});
