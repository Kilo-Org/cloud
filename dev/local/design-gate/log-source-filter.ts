import { finding, type Finding } from './findings';
import type { LayoutTree } from './tree';

/** React's warning for an update dispatched to a component it has not committed. */
export const NOT_YET_MOUNTED_WARNING =
  "Can't perform a React state update on a component that hasn't mounted yet";

/** Where the installed filter keeps its counters, per JavaScript runtime. */
export const LOG_SOURCE_FILTER_KEY = '__kiloDesignGateLogSourceFilter';

/**
 * The styling engine's copy of React's warning, as the gate tells it from app
 * code.
 *
 * react-native-css subscribes every styled component to the color-scheme and
 * dimension observables inside `useNativeCss`'s `useState` initializer, so a
 * theme or density change delivered while React still has an uncommitted render
 * (the offscreen prerender of a hidden Activity, which every tab stack creates
 * with `activityEnabled={1}`) dispatches into a component that never mounted.
 * The dispatch enters through `styleEffect.run` in that package, which is what
 * the call stack at the warning records.
 *
 * The same message from app code is a real defect and must still reach the
 * screen, so the source, not the text, decides.
 */
const ENGINE_PACKAGE = 'react-native-css';
const ENGINE_ENTRY = 'useNativeCss';
const ENGINE_EFFECT = 'styleEffect';

/**
 * The expression the gate evaluates in the app runtime.
 *
 * It replaces `console.error` before the warning is logged, so a later one never
 * reaches LogBox; the stack read at the call site is the dispatch React
 * rejected. `Error.stackTraceLimit` is raised first because that dispatch sits
 * several frames below the log call.
 *
 * A warning painted before the replacement — a cell config restarts the app
 * runtime, and its first warning can beat the runner's attach — is dismissed
 * from LogBox, but only when one of its recorded frames names the engine.
 * LogBox exports no public accessor for its logs, so the module is found
 * through the registry; a runtime without it keeps the toast, and the screen
 * rule then reports it as a defect.
 *
 * Idempotent per runtime, so every readiness wait runs it.
 */
export function logSourceFilterExpression(): string {
  return `(() => {
  const key = ${JSON.stringify(LOG_SOURCE_FILTER_KEY)};
  const warning = ${JSON.stringify(NOT_YET_MOUNTED_WARNING)};
  const enginePackage = ${JSON.stringify(ENGINE_PACKAGE)};
  const engineEntry = ${JSON.stringify(ENGINE_ENTRY)};
  const engineEffect = ${JSON.stringify(ENGINE_EFFECT)};
  const stackFromEngine = stack =>
    stack.includes(enginePackage) && (stack.includes(engineEntry) || stack.includes(engineEffect));
  const fromEngine = frame => {
    const file = String((frame && frame.file) || '');
    const method = String((frame && frame.methodName) || '');
    return stackFromEngine(file + ' ' + method);
  };
  const isEngineLog = log => {
    const content = String((log && log.message && log.message.content) || '');
    if (!content.includes(warning)) return false;
    const frames = [];
    if (Array.isArray(log.stack)) frames.push.apply(frames, log.stack);
    if (Array.isArray(log.componentStack)) frames.push.apply(frames, log.componentStack);
    return frames.some(fromEngine);
  };
  const findLogBox = () => {
    const registry = globalThis.__r;
    if (typeof registry !== 'function' || typeof registry.getModules !== 'function') return null;
    for (const entry of registry.getModules().values()) {
      const exported = entry && entry.publicModule && entry.publicModule.exports;
      for (const candidate of [exported, exported && exported.default]) {
        if (
          candidate &&
          typeof candidate.observe === 'function' &&
          typeof candidate.dismiss === 'function' &&
          typeof candidate.addLog === 'function' &&
          typeof candidate.setDisabled === 'function'
        ) {
          return candidate;
        }
      }
    }
    return null;
  };
  let state = globalThis[key];
  if (state === undefined) {
    try {
      Error.stackTraceLimit = Math.max(Number(Error.stackTraceLimit) || 0, 50);
    } catch (error) {
      // A runtime with a fixed stack depth still filters by what it keeps.
    }
    const original = console.error;
    state = { suppressed: 0, forwardedGuard: 0, dismissed: 0 };
    console.error = function (...args) {
      const message = typeof args[0] === 'string' ? args[0] : '';
      if (message.includes(warning)) {
        let stack = '';
        try {
          stack = String(new Error().stack || '');
        } catch (error) {
          stack = '';
        }
        if (stackFromEngine(stack)) {
          state.suppressed += 1;
          return undefined;
        }
        state.forwardedGuard += 1;
      }
      return original.apply(this, args);
    };
    globalThis[key] = state;
  }
  const logBox = state.logBox || findLogBox();
  if (logBox === null || logBox === undefined) return 'installed';
  state.logBox = logBox;
  let dismissed = [];
  const subscription = logBox.observe(current => {
    dismissed = Array.from((current && current.logs) || []).filter(isEngineLog);
  });
  if (subscription && typeof subscription.unsubscribe === 'function') subscription.unsubscribe();
  for (const log of dismissed) {
    try {
      logBox.dismiss(log);
      state.dismissed += 1;
    } catch (error) {
      // A log LogBox no longer holds needs no dismissal.
    }
  }
  return 'installed';
})()`;
}

/** Reads the filter's counters for the run log; `null` when it never installed. */
export function logSourceFilterStatsExpression(): string {
  return `(() => {
  const state = globalThis[${JSON.stringify(LOG_SOURCE_FILTER_KEY)}];
  return state === undefined
    ? null
    : {
        suppressed: state.suppressed,
        forwardedGuard: state.forwardedGuard,
        dismissed: state.dismissed,
      };
})()`;
}

/**
 * A warning of this kind that reached the screen after the filter was installed
 * came from app code (or predates the install, which the dump cannot tell
 * apart), so the cell reports it instead of hiding it.
 */
export function checkDevLogOverlay(tree: LayoutTree): Finding[] {
  const overlay = tree.nodes.find(
    node =>
      node.probe.testID?.startsWith('logbox') === true &&
      (node.probe.text ?? '').includes(NOT_YET_MOUNTED_WARNING)
  );
  if (overlay === undefined) return [];
  return [
    finding({
      rule: 'dev-overlay',
      severity: 'error',
      element: overlay.ref,
      measured: overlay.rect[3],
      expected: 'no React state-update warning over the screen',
      unit: 'dp',
      message: `React's "${NOT_YET_MOUNTED_WARNING}" is painted over this screen. The gate closes it only when a recorded frame names react-native-css (useNativeCss/styleEffect); a warning that still reached the screen came from app code (or was logged with no attributable stack), so it stays a defect.`,
    }),
  ];
}
