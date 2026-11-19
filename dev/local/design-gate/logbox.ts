import { finding, type Finding } from './findings';
import type { ProbeDump, ProbeNode } from './tree';

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

/** The node LogBox renders a notification's text into. */
const LOGBOX_MESSAGE_TEST_ID = 'logbox_notification_message_text';
/** The badge that counts notifications, whose text is not a message. */
const LOGBOX_COUNT_TEST_ID = 'logbox_notification_count_text';
/**
 * LogBox carries the level it painted at in its buttons' test IDs:
 * `logbox_open_button_error`, `logbox_dismiss_button_warn` and so on. That is
 * LogBox's own classification, which the message text cannot stand in for: a
 * dev warning quoted in the text is not an error, and an error need not mention
 * anything the gate could recognize.
 */
const LOGBOX_LEVEL_TEST_ID = /^logbox_(?:open|dismiss)_button_(warn|error)$/;

function notificationLevel(dump: ProbeDump): 'warn' | 'error' | undefined {
  // A notification paints one level's buttons; error wins only because a dump
  // holding both would be two notifications and the stricter reading is safe.
  const levels = new Set(
    dump.nodes.flatMap(node => {
      const match = node.testID === undefined ? null : LOGBOX_LEVEL_TEST_ID.exec(node.testID);
      return match === null ? [] : [match[1]];
    })
  );
  return levels.has('error') ? 'error' : levels.has('warn') ? 'warn' : undefined;
}

/**
 * The raw dump, not the normalized tree: `normalize` drops LogBox chrome (its
 * owners are ignored overlays), which keeps the toast's buttons out of the
 * layout rules and would also hide the toast from this rule.
 *
 * Every readiness wait has disabled LogBox's UI by the time a screen is
 * captured, so a toast in the dump means either the switch failed in this
 * runtime or that some code really did raise a message while the screen was up.
 * The gate cannot tell a dev warning the environment painted (an app whose
 * runtime refused the switch) from an error the run's own fixture, diagnostic
 * manifest or product raised, so it takes LogBox's level: an error paints over
 * the screen the gate meant to grade, so it fails the run and the screen is
 * judged only once the overlay is gone, while a warning keeps the screen's own
 * faults as the errors the run reports. Reporting a painted error as a product
 * finding instead lets whatever painted the toast be mistaken for a defect of
 * the screen a critic would then see only through the toast.
 *
 * The run log says whether any module exposed the switch, which is what tells a
 * runtime without LogBox apart from one that refused it.
 */
export function checkDevLogOverlay(dump: ProbeDump): Finding[] {
  // One notification yields one finding: the message text and the chrome that
  // repeats it carry the same string, so the text is the notification's identity
  // and the descriptor that names the message is preferred.
  const messages = new Map<string, { node: ProbeNode; index: number; text: string }>();
  dump.nodes.forEach((node, index) => {
    if (node.testID?.startsWith('logbox') !== true) return;
    // The badge carries the notification count, not a message; the message is a
    // separate node, so counting the badge would double one notification.
    if (node.testID === LOGBOX_COUNT_TEST_ID) return;
    const text = (node.text ?? '').trim();
    if (text === '') return;
    const seen = messages.get(text);
    const better =
      seen !== undefined &&
      seen.node.testID !== LOGBOX_MESSAGE_TEST_ID &&
      node.testID === LOGBOX_MESSAGE_TEST_ID;
    if (seen !== undefined && !better) return;
    messages.set(text, { node, index, text });
  });
  const level = notificationLevel(dump);
  return [...messages.values()].map(({ node, index, text }) =>
    finding({
      rule: 'dev-overlay',
      // Without level chrome the dump cannot say how LogBox painted this: fall
      // back to the one message the gate knows is an environment warning and
      // treat anything else as the error it must be assumed to be.
      severity:
        level === undefined
          ? text.includes(NOT_YET_MOUNTED_WARNING)
            ? 'warning'
            : 'error'
          : level === 'error'
            ? 'error'
            : 'warning',
      element: {
        index,
        path: node.testID === undefined ? node.tag : `testID:${node.testID}`,
        tag: node.tag,
        ...(node.owners === undefined ? {} : { owners: [...node.owners] }),
        ...(node.text === undefined ? {} : { text: node.text }),
        ...(node.testID === undefined ? {} : { testID: node.testID }),
        ...(node.label === undefined ? {} : { label: node.label }),
        rect: node.rect,
      },
      measured: node.rect[3],
      expected: 'no LogBox toast painted over the screen',
      unit: 'dp',
      message: text.includes(NOT_YET_MOUNTED_WARNING)
        ? `LogBox painted React's "${NOT_YET_MOUNTED_WARNING}" over this screen although the gate disables its UI at every readiness wait. Disabling failed in this runtime, which is an environment problem rather than a fault of the screen: the gate never wraps console.*, so a toast it cannot close is reported and not graded. Dev warnings are for Metro and LogBox in normal use.`
        : `LogBox painted "${text}" over this screen, so the capture shows a dev overlay rather than the screen alone and the gate cannot grade what it covers. The overlay is the run's to fix — its fixture or diagnostic manifest, or the product — before this screen is judged; it is a finding about the run, not about the screen.`,
    })
  );
}
