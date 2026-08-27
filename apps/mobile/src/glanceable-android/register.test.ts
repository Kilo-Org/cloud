import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AndroidWidgetProps } from './widget-props';

const taskHandlerMock = vi.hoisted(() => ({
  handler: null as ((props: Record<string, unknown>) => Promise<void>) | null,
}));

const persistMock = vi.hoisted(() => ({
  restorePersistedGlanceable: vi.fn().mockResolvedValue(undefined),
  getLastGlanceableSnapshot: vi.fn((): GlanceableAgentsSnapshot | null => null),
}));

const sinkMock = vi.hoisted(() => ({
  androidSink: {},
  getCurrentWidgetProps: vi.fn((): AndroidWidgetProps | null => null),
  handleAppStateActive: vi.fn(),
  handleWidgetOpenTap: vi.fn(),
}));

const openAgentsMock = vi.hoisted(() => ({
  openGlanceableAgents: vi.fn(),
}));

const registerSinkMock = vi.hoisted(() => ({
  registerGlanceableSink: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('react-native-android-widget', () => ({
  registerWidgetTaskHandler: (handler: unknown) => {
    taskHandlerMock.handler = handler as (props: Record<string, unknown>) => Promise<void>;
  },
}));

vi.mock('@/lib/glanceable/persist', () => persistMock);
vi.mock('@/lib/glanceable/sink-registry', () => registerSinkMock);
vi.mock('@/lib/glanceable/open-agents', () => openAgentsMock);
vi.mock('./android-sink', () => sinkMock);
vi.mock('./active-agents-widget', () => ({
  OPEN_AGENTS_CLICK: 'OPEN_AGENTS',
  renderActiveAgentsWidget: (props: unknown) => props,
}));

// eslint-disable-next-line import/first -- mocks must register before the module under test
import './register';

const NOW = 1_750_000_000_000;

function snapshotFor(sessions: { status: string }[]): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: 0,
  });
}

function runRenderTask(): ReturnType<typeof vi.fn> {
  const renderWidget = vi.fn();
  const task = {
    widgetInfo: {},
    widgetAction: 'WIDGET_UPDATE',
    clickAction: undefined,
    renderWidget,
  };
  void (taskHandlerMock.handler as (props: Record<string, unknown>) => Promise<void>)(task);
  return renderWidget;
}

describe('android register widget task handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistMock.restorePersistedGlanceable.mockResolvedValue(undefined);
    persistMock.getLastGlanceableSnapshot.mockReturnValue(null);
    sinkMock.getCurrentWidgetProps.mockReturnValue(null);
  });

  it('restores the persisted snapshot and rebuilds props from it after a restart', async () => {
    persistMock.getLastGlanceableSnapshot.mockReturnValue(snapshotFor([{ status: 'busy' }]));
    const renderWidget = runRenderTask();

    await vi.waitFor(() => {
      expect(renderWidget).toHaveBeenCalledTimes(1);
    });
    expect(persistMock.restorePersistedGlanceable).toHaveBeenCalledTimes(1);

    const props = renderWidget.mock.calls[0]?.[0] as AndroidWidgetProps | undefined;
    expect(props?.statusLine).toBeNull();
    expect(props?.primaryCount).toBe(1);
    expect(props?.countLines).toHaveLength(1);
  });

  it('uses the generic empty placeholder only when no snapshot exists', async () => {
    persistMock.getLastGlanceableSnapshot.mockReturnValue(null);
    const renderWidget = runRenderTask();

    await vi.waitFor(() => {
      expect(renderWidget).toHaveBeenCalledTimes(1);
    });

    const props = renderWidget.mock.calls[0]?.[0] as AndroidWidgetProps | undefined;
    expect(props?.statusLine).toBe('No work in progress');
    expect(props?.countLines).toEqual([]);
    expect(props?.primaryCount).toBe(0);
    expect(props?.showOpenAgents).toBe(false);
  });

  it('renders in-memory props on a redraw without restoring persist', async () => {
    const liveProps: AndroidWidgetProps = {
      statusLine: null,
      countLines: [],
      primaryLabel: null,
      primaryCount: 0,
      openAgentsLabel: 'Open agents',
      showOpenAgents: false,
      accessibilityLabel: '',
    };
    sinkMock.getCurrentWidgetProps.mockReturnValue(liveProps);
    const renderWidget = runRenderTask();

    await vi.waitFor(() => {
      expect(renderWidget).toHaveBeenCalledTimes(1);
    });
    expect(persistMock.restorePersistedGlanceable).not.toHaveBeenCalled();
    expect(renderWidget).toHaveBeenCalledWith(liveProps);
  });
});
