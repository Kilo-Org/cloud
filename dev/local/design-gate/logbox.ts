import { finding, type Finding } from './findings';
import type { ProbeDump } from './tree';

/** React's warning for an update dispatched to a component it has not committed. */
export const NOT_YET_MOUNTED_WARNING =
  "Can't perform a React state update on a component that hasn't mounted yet";

/** What one disable pass found in the app runtime. */
export type LogBoxDisable = Readonly<{
  /** Modules of the runtime whose exports carry a `setDisabled` function. */
  exposing: number;
  /** Modules this gate has disabled, counted once per runtime. */
  disabled: number;
}>;

/** Where a runtime records the modules it already disabled. */
export const LOGBOX_DISABLE_KEY = '__kiloDesignGateLogBox';

/**
 * Turns off LogBox's UI in the app runtime, so a warning toast does not paint
 * over a capture.
 *
 * The gate does not touch `console.*`. Wrapping `console.error` replaced the
 * function inside a chain it does not own — the app's Sentry integration has
 * already wrapped the same method, and its wrapper calls the previous one as
 * `log?.apply(...)`; a bare function installed in between makes that call throw,
 * and LogBox paints a full-screen error where a toast would have been.
 *
 * LogBox exports the switch that matters: its data store has `setDisabled`, and
 * Metro exposes it as a module of the runtime's registry. Every module that
 * offers it is disabled, through its namespace export and its default export,
 * because a package can expose one store through either. The pass records what
 * it disabled on `globalThis`, which a reload resets with the runtime, so the
 * next wait disables again while a repeat call in the same runtime is a no-op.
 * `exposing` lets the run log say that nothing in this runtime offered the
 * switch.
 */
export function logBoxDisableExpression(): string {
  return `(() => {
  const key = ${JSON.stringify(LOGBOX_DISABLE_KEY)};
  const state = globalThis[key] || { modules: [] };
  globalThis[key] = state;
  const disabled = new Set(state.modules);
  const registry = globalThis.__r;
  const modules =
    registry !== null && registry !== undefined && typeof registry.getModules === 'function'
      ? registry.getModules()
      : null;
  // The ids carried from an earlier pass were disabled then; this pass inspected
  // no module, so it exposes no module either.
  if (modules === null) return { exposing: 0, disabled: disabled.size };
  const exposing = new Map();
  for (const [id, entry] of modules.entries()) {
    const exported = entry && entry.publicModule && entry.publicModule.exports;
    const candidates = [exported, exported && exported.default].filter(
      candidate => candidate !== null && candidate !== undefined && typeof candidate.setDisabled === 'function'
    );
    if (candidates.length > 0) exposing.set(id, candidates);
  }
  for (const [id, candidates] of exposing.entries()) {
    if (disabled.has(id)) continue;
    let silenced = false;
    for (const candidate of candidates) {
      try {
        candidate.setDisabled(true);
        silenced = true;
      } catch (error) {
        // A store that refuses the switch leaves its toast to the dump rule.
      }
    }
    if (!silenced) continue;
    disabled.add(id);
    state.modules.push(id);
  }
  return { exposing: exposing.size, disabled: disabled.size };
})()`;
}

/**
 * The raw dump, not the normalized tree: `normalize` drops LogBox chrome (its
 * owners are ignored overlays), which keeps the toast's buttons out of the
 * layout rules and would also hide the toast from this rule.
 *
 * Every readiness wait has disabled LogBox's UI by the time a screen is
 * captured, so a toast in the dump means the switch failed in this runtime: an
 * environment problem, not a layout defect, and therefore a warning rather than
 * the product error the gate reports for a screen's own faults. The run log says
 * whether any module exposed the switch, which is what tells a runtime without
 * LogBox apart from one that refused it.
 */
export function checkDevLogOverlay(dump: ProbeDump): Finding[] {
  const overlay = dump.nodes.find(
    node =>
      node.testID?.startsWith('logbox') === true &&
      (node.text ?? '').includes(NOT_YET_MOUNTED_WARNING)
  );
  if (overlay === undefined) return [];
  return [
    finding({
      rule: 'dev-overlay',
      severity: 'warning',
      element: {
        index: dump.nodes.indexOf(overlay),
        path: overlay.testID === undefined ? overlay.tag : `testID:${overlay.testID}`,
        tag: overlay.tag,
        ...(overlay.owners === undefined ? {} : { owners: [...overlay.owners] }),
        ...(overlay.text === undefined ? {} : { text: overlay.text }),
        ...(overlay.testID === undefined ? {} : { testID: overlay.testID }),
        ...(overlay.label === undefined ? {} : { label: overlay.label }),
        rect: overlay.rect,
      },
      measured: overlay.rect[3],
      expected: 'no LogBox toast painted over the screen',
      unit: 'dp',
      message: `LogBox painted React's "${NOT_YET_MOUNTED_WARNING}" over this screen although the gate disables its UI at every readiness wait. Disabling failed in this runtime, which is an environment problem rather than a fault of the screen: the gate never wraps console.*, so a toast it cannot close is reported and not graded. Dev warnings are for Metro and LogBox in normal use.`,
    }),
  ];
}
