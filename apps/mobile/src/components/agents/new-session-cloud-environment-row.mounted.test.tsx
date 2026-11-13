import { afterEach, describe, expect, it, vi } from 'vitest';

import { TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import {
  type EnvironmentSelection,
  type EnvironmentSummaryRow,
} from '@/lib/cloud-environments/environment-selection';

import { NewSessionCloudEnvironmentRow } from './new-session-cloud-environment-row';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

type RowProps = Parameters<typeof NewSessionCloudEnvironmentRow>[0];

const CARD_CHROME = `${ROW_TARGET_CLASS} flex-row items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5`;
const ROW_TEST_ID = 'session-cloud-environment-row';

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

type PickerSelection = Exclude<EnvironmentSelection, { status: 'idle' }>;

const CHOOSE: PickerSelection = {
  status: 'choose',
  environments: [ENVIRONMENT, OTHER_ENVIRONMENT],
};

const SELECTED: PickerSelection = {
  status: 'selected',
  environment: ENVIRONMENT,
  chosen: true,
};

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

function renderRow(overrides: Partial<RowProps> = {}) {
  const element = (
    <NewSessionCloudEnvironmentRow
      selection={CHOOSE}
      isError={false}
      buildStatus={undefined}
      buildStatusFailed={false}
      disabled={false}
      onRetry={vi.fn<() => void>()}
      onOpen={vi.fn<() => void>()}
      {...overrides}
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
    throw new Error('Cloud environment row did not mount');
  }
  return renderer.root;
}

function rowNode(root: TestRenderer.ReactTestInstance) {
  const [node] = root.findAll(candidate => candidate.props.testID === ROW_TEST_ID);
  if (!node) {
    throw new Error('the row did not render its card');
  }
  return node;
}

function renderedTexts(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => (node.type as string) === 'Text')
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'));
}

describe('NewSessionCloudEnvironmentRow picker entry', () => {
  it.each([
    { state: 'choose' as const, selection: CHOOSE },
    { state: 'selected' as const, selection: SELECTED },
  ])('opens the sheet when pressed in the $state state', ({ selection }) => {
    const onOpen = vi.fn<() => void>();
    const root = renderRow({ selection, onOpen });

    const node = rowNode(root);
    // The tappable node must carry the card's own chrome: an unstyled pressable
    // around a styled card is flattened away and never receives the touch.
    expect(node.type).toBe('Pressable');
    expect(node.props.className).toContain(CARD_CHROME);
    expect(node.props.accessibilityRole).toBe('button');
    expect(node.props.accessibilityState).toEqual({ disabled: false });

    TestRenderer.act(() => {
      (node.props.onPress as () => void)();
    });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('names the choice and its reason in the choose state', () => {
    const root = renderRow();
    const values = renderedTexts(root);

    expect(values).toContain(i18n.t('agentChat.newSession.cloudEnvironment'));
    expect(values).toContain(i18n.t('agentChat.environment.chooseEnvironment'));
    expect(values).toContain(i18n.t('agentChat.environment.chooseEnvironmentDetail'));
  });

  it('shows the picked environment and its build line in the selected state', () => {
    const root = renderRow({ selection: SELECTED });
    const values = renderedTexts(root);

    expect(values).toContain('Mobile parity lab');
    expect(values).toContain(i18n.t('common.loading'));
  });

  it('does not open the sheet while a create is in flight', () => {
    const onOpen = vi.fn<() => void>();
    const root = renderRow({ disabled: true, onOpen });

    const node = rowNode(root);
    expect(node.props.onPress).toBeUndefined();
    expect(node.props.accessibilityState).toEqual({ disabled: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('says the build status could not be read instead of loading it forever', () => {
    const root = renderRow({ selection: SELECTED, buildStatusFailed: true });
    const values = renderedTexts(root);

    expect(values).toContain('Mobile parity lab');
    expect(values).toContain(i18n.t('agentChat.environment.couldNotLoadBuild'));
    expect(values).not.toContain(i18n.t('common.loading'));
  });

  it('renders no picker for a repository without environments and retries a failed list', () => {
    const onRetry = vi.fn<() => void>();
    const root = renderRow({ selection: { status: 'none' }, onRetry });

    expect(rowNode(root).type).toBe('View');
    expect(renderedTexts(root)).toContain(i18n.t('agentChat.environment.noEnvironment'));

    const retryTargets = renderRow({ selection: { status: 'unknown' }, onRetry }).findAll(
      node => node.props.accessibilityLabel === i18n.t('common.retry')
    );
    const retryTarget = retryTargets[0];
    if (!retryTarget) {
      throw new Error('the failed list did not offer Retry');
    }
    expect(retryTargets).toHaveLength(1);
    TestRenderer.act(() => {
      (retryTarget.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
