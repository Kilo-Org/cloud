import { AppState, Linking } from 'react-native';
import { type WidgetTaskHandlerProps } from 'react-native-android-widget';

import { i18n } from '@/i18n';
import { applyStoredLanguage } from '@/lib/glanceable/apply-stored-language';
import {
  getLiveActivityEnabled,
  subscribeLiveActivityEnabled,
} from '@/lib/glanceable/live-activity-switch';
import { getLastGlanceableSnapshot, restorePersistedGlanceable } from '@/lib/glanceable/persist';
import { registerGlanceableSink } from '@/lib/glanceable/sink-registry';
import { getSurfaceExtras, setSurfaceExtras } from '@/lib/glanceable/surface-extras';
import {
  failureFeedback,
  runningFeedback,
  runWidgetAction,
  type WidgetAction,
} from '@/lib/glanceable/widget-actions';

import { renderActiveAgentsWidget } from './active-agents-widget';
import { androidSink, getCurrentWidgetProps, handleAppStateActive } from './android-sink';
import { formatGlanceableCount, isWidgetRtl } from './count-format';
import { getStoredWidgetSnapshot, setWidgetSnapshot } from './live-update';
import {
  type AndroidWidgetProps,
  buildCurrentWidgetProps,
  buildGenericWidgetProps,
} from './widget-props';

// Register the Android sink at import time. The main-app import of the local
// live-update module loads this file, so the sink subscribes before any widget
// render. No React dependency here: the publisher is plain state.
registerGlanceableSink(androidSink);

// The permission alert needs a foreground Activity; RN Android's AlertModule
// no-ops in headless JS. Show it when the app returns to the foreground instead.
AppState.addEventListener('change', state => {
  if (state === 'active') {
    void handleAppStateActive();
  }
});

// Turning the in-app switch off must clear the Live Update already in the
// shade, not just stop the next start. `startOrUpdate` holds the guard for
// everything after this.
let liveUpdateAllowed = getLiveActivityEnabled();
subscribeLiveActivityEnabled(() => {
  const next = getLiveActivityEnabled();
  if (liveUpdateAllowed && !next) {
    androidSink.endImmediate();
  }
  liveUpdateAllowed = next;
});

function translate(key: string): string {
  return i18n.t(key);
}

/**
 * Switch i18n to the user's language before a headless render or press.
 *
 * A widget redraw and the notification's Approve both run as headless JS tasks
 * with no Activity, so the app's root never mounts and nothing else applies the
 * language — without this the placed widget renders English whatever the user
 * chose. Exported because the headless approve task runs the same way and must
 * speak one language with it; the language step itself is `applyStoredLanguage`,
 * the same one `handleWidgetTask` takes.
 */
export async function applyWidgetLanguage(): Promise<void> {
  await applyStoredLanguage();
}

/** The custom click actions the widget's own rows emit (never OPEN_APP/OPEN_URI). */
function isWidgetAction(value: string | undefined): value is WidgetAction {
  return value === 'approve' || value === 'new-agent';
}

/** Where an unfinished action lands: the same agents list the body tap opens. */
const OPEN_AGENTS_URI = 'kiloapp:///cloud/sessions';
/** Where a create with nothing to start from lands: the new-session screen. */
const OPEN_NEW_AGENT_URI = 'kiloapp://agent-chat/new';

/**
 * Run one in-place action and redraw the widget the user is looking at. The
 * action's request goes out with its progress line already drawn, and the
 * redraw after it re-reads native storage: a successful action republishes the
 * tray through the sink, which writes the new snapshot there (see
 * `runWidgetAction`). A custom clickAction itself never opens the app — it
 * launches a headless task — but an action that cannot complete in place hands
 * the user to the app instead of dead-ending on the widget.
 */
async function handleWidgetAction(
  action: WidgetAction,
  task: Pick<WidgetTaskHandlerProps, 'renderWidget' | 'widgetInfo'>,
  currentProps: () => AndroidWidgetProps
): Promise<void> {
  const { renderWidget, widgetInfo } = task;
  const draw = () => {
    renderWidget(renderActiveAgentsWidget(currentProps(), widgetInfo, isWidgetRtl()));
  };
  setSurfaceExtras({ ...getSurfaceExtras(), actionFeedback: runningFeedback(action) });
  draw();
  const result = await runWidgetAction(action);
  setSurfaceExtras({
    ...getSurfaceExtras(),
    // The failure line is the action's own retry copy, and the row that was
    // tapped stays offered; the body tap still opens Kilo.
    actionFeedback: result.kind === 'failed' ? failureFeedback(action) : null,
  });
  draw();
  // Nothing to act on, or the agent asked a free-form question the widget must
  // never invent an answer to: the action hands the user to the app. The
  // create action lands on the new-session screen when it had no draft or
  // repository to start from; a failed call stays on the widget, whose retry
  // row and body tap remain offered.
  if (result.kind === 'none' || result.kind === 'no-permission') {
    const uri = action === 'approve' ? OPEN_AGENTS_URI : OPEN_NEW_AGENT_URI;
    try {
      await Linking.openURL(uri);
    } catch {
      // A host that cannot start the Activity leaves the settled widget on
      // screen; the task itself must not fail on the open.
    }
  }
}

/**
 * Redraw a placed widget. Registered from the app entry, which loads this
 * module only when a task fires: a widget redraw runs headless, so nothing
 * else has loaded the Android sink by then.
 */
export async function handleWidgetTask(task: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, renderWidget, widgetAction, clickAction } = task;

  await applyStoredLanguage();

  // Re-read native storage even in a live process. An old alarm can already have
  // queued this task when newer work or a privacy blank replaces its deadline.
  const stored = getStoredWidgetSnapshot();
  let snapshot = stored;
  let props =
    stored === null
      ? getCurrentWidgetProps()
      : buildCurrentWidgetProps(stored, translate, formatGlanceableCount);
  if (props === null) {
    // Migrate the existing mirror when this installation has no native snapshot yet.
    await restorePersistedGlanceable();
    const restored = getLastGlanceableSnapshot();
    if (restored !== null && getCurrentWidgetProps() === null) {
      setWidgetSnapshot(restored);
    }
    const live = getCurrentWidgetProps();
    if (live === null) {
      snapshot = restored;
      props =
        restored === null
          ? buildGenericWidgetProps(translate)
          : buildCurrentWidgetProps(restored, translate, formatGlanceableCount);
    } else {
      // A live publish during restoration owns the widget.
      snapshot = null;
      props = live;
    }
  }

  // Redraw from native storage, which is authoritative even when an obsolete
  // task was already queued. An in-place action republishes the tray through
  // the sink, which writes the new snapshot there, so the redraw after it shows
  // the new counts instead of the snapshot this task started with. `snapshot`
  // and `props` are the fallback when native storage holds nothing.
  const currentProps = (): AndroidWidgetProps => {
    const latest = getStoredWidgetSnapshot();
    if (latest !== null) {
      return buildCurrentWidgetProps(latest, translate, formatGlanceableCount);
    }
    return snapshot === null
      ? props
      : buildCurrentWidgetProps(snapshot, translate, formatGlanceableCount);
  };
  if (widgetAction === 'WIDGET_CLICK' && isWidgetAction(clickAction)) {
    await handleWidgetAction(clickAction, task, currentProps);
    return;
  }
  renderWidget(renderActiveAgentsWidget(currentProps(), widgetInfo, isWidgetRtl()));
}
