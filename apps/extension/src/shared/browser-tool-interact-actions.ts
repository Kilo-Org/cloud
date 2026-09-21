/* eslint-disable id-length, max-lines -- CDP mouse commands name their coordinates `x` and `y`; one module owns the eight interaction tools and the shared CDP and page-helper plumbing keeps their shapes consistent. */
import { z } from 'zod';
import { buildWorkflowPageCode } from './agent-workflow-runner';
import type { BrowserToolResolvedTarget } from './browser-tool-session';
import type { EvalTabResult } from './tab-debugger';

/**
 * The slice of `BrowserToolSession` the interaction tools need: the snapshot ref
 * registry and the CDP command channel. A full `BrowserToolSession` satisfies it
 * structurally; naming only these two keeps the tools testable with a fake and
 * independent of the session's platform wiring.
 */
export interface BrowserToolInteractSession {
  readonly resolveTarget: (target: string) => Promise<BrowserToolResolvedTarget | undefined>;
  readonly send: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown> | undefined>;
}

/**
 * The eight upstream Playwright MCP interaction tools this module implements.
 * Names are upstream names (no `kilo_` prefix); the executor maps a model-facing
 * `kilo_browser_*` call onto one of these.
 */
export const INTERACT_BROWSER_TOOL_NAMES = [
  'browser_click',
  'browser_drag',
  'browser_drop',
  'browser_fill_form',
  'browser_hover',
  'browser_press_key',
  'browser_select_option',
  'browser_type',
] as const;

export type InteractBrowserToolName = (typeof INTERACT_BROWSER_TOOL_NAMES)[number];

const INTERACT_BROWSER_TOOL_NAME_SET: ReadonlySet<string> = new Set(INTERACT_BROWSER_TOOL_NAMES);
const KILO_BROWSER_TOOL_PREFIX = 'kilo_';

const toUpstreamToolName = (name: string): string =>
  name.startsWith(KILO_BROWSER_TOOL_PREFIX) ? name.slice(KILO_BROWSER_TOOL_PREFIX.length) : name;

/** Accepts either the upstream name (`browser_click`) or the model-facing `kilo_` name. */
export const isInteractBrowserToolName = (name: string): boolean =>
  INTERACT_BROWSER_TOOL_NAME_SET.has(toUpstreamToolName(name));

const STALE_REF_ERROR_PREFIX = 'The element reference is stale or unknown.';
const FRESH_SNAPSHOT_HINT =
  'Take a fresh kilo_browser_snapshot and use a ref from that snapshot, or pass a unique CSS selector.';
const STALE_REF_ERROR = `${STALE_REF_ERROR_PREFIX} ${FRESH_SNAPSHOT_HINT}`;

const ok = (message: string): EvalTabResult => ({ ok: true, value: message });
const fail = (error: string): EvalTabResult => ({ error, ok: false });

/** Values the page-helper scripts return to this module. */
type PageHelperValue = boolean | string | readonly string[] | null;
const pageHelperValueSchema = z.union([z.boolean(), z.string(), z.array(z.string()), z.null()]);
const okValue = (value: PageHelperValue): EvalTabResult => ({ ok: true, value });

const invalidArguments = (tool: string, error: string): EvalTabResult =>
  fail(`${tool}: invalid arguments. ${error}`);

const refPattern = /^(?:ref=)?(?:f\d+)?e\d+$/u;
const looksLikeRef = (target: string): boolean => refPattern.test(target.trim());

type TargetResolution =
  | { readonly ok: true; readonly target: BrowserToolResolvedTarget }
  | { readonly ok: false; readonly error: string };

const resolveTargetOrError = async (
  session: BrowserToolInteractSession,
  target: string
): Promise<TargetResolution> => {
  const resolved = await session.resolveTarget(target);

  if (resolved !== undefined) {
    return { ok: true, target: resolved };
  }

  if (looksLikeRef(target)) {
    return { error: STALE_REF_ERROR, ok: false };
  }

  return {
    error: `No element matches the selector "${target}". Check the selector, or take a fresh kilo_browser_snapshot and use a ref.`,
    ok: false,
  };
};

type CentreResult =
  | { readonly centreX: number; readonly centreY: number; readonly ok: true }
  | { readonly error: string; readonly ok: false };

const nodeParams = (target: BrowserToolResolvedTarget): Record<string, unknown> =>
  target.kind === 'ref' ? { backendNodeId: target.backendNodeId } : { nodeId: target.nodeId };

const boxModelResponseSchema = z.object({
  model: z.object({
    content: z.tuple([
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
      z.number(),
    ]),
  }),
});

/** Sends a CDP command, treating a rejected command as a missing element. */
const sendOrUndefined = async (
  session: BrowserToolInteractSession,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> => {
  try {
    return await session.send(method, params);
  } catch {
    return undefined;
  }
};

const NO_VISIBLE_BOX_ERROR =
  'The element has no visible box to interact with. Scroll it into view, wait for it to render, or target a visible element.';

/**
 * Scrolls the element into view and returns the centre of its content box.
 * `DOM.getBoxModel` already reports viewport-relative coordinates (the same
 * space `Input.dispatchMouseEvent` takes), so no scroll conversion is applied.
 * A ref whose node was removed without a navigation rejects the CDP call; that
 * is the same stale reference as an unknown ref, so the model gets the same
 * re-snapshot message instead of a raw protocol error.
 */
const resolveCentre = async (
  session: BrowserToolInteractSession,
  target: BrowserToolResolvedTarget
): Promise<CentreResult> => {
  try {
    await session.send('DOM.scrollIntoViewIfNeeded', nodeParams(target));
  } catch {
    // Best effort: the box model below reports an element with no layout.
  }

  const response = await sendOrUndefined(session, 'DOM.getBoxModel', nodeParams(target));
  const parsed = boxModelResponseSchema.safeParse(response);

  if (!parsed.success) {
    return {
      error: target.kind === 'ref' ? STALE_REF_ERROR : NO_VISIBLE_BOX_ERROR,
      ok: false,
    };
  }

  const [x1, y1, x2, y2, x3, y3, x4, y4] = parsed.data.model.content;

  return {
    centreX: (x1 + x2 + x3 + x4) / 4,
    centreY: (y1 + y2 + y3 + y4) / 4,
    ok: true,
  };
};

const MODIFIER_BITS = { Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8 } as const;

type ModifierName = keyof typeof MODIFIER_BITS;

const modifierSchema = z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift']);

const isMacPlatform = (): boolean => /Mac|iPhone|iPad/u.test(globalThis.navigator?.userAgent ?? '');

const modifierBits = (modifier: ModifierName): number =>
  modifier === 'ControlOrMeta' && isMacPlatform() ? 4 : MODIFIER_BITS[modifier];

const modifierMask = (modifiers: readonly ModifierName[] | undefined): number => {
  let mask = 0;

  for (const modifier of modifiers ?? []) {
    mask |= modifierBits(modifier);
  }

  return mask;
};

const buttonBits = (button: 'left' | 'right' | 'middle'): number => {
  if (button === 'right') {
    return 2;
  }

  return button === 'middle' ? 4 : 1;
};

type MouseButton = 'left' | 'right' | 'middle';

interface ClickDispatch {
  readonly button: MouseButton;
  readonly centreX: number;
  readonly centreY: number;
  readonly clickCount: number;
  readonly modifiers: number;
}

const dispatchClick = async (
  session: BrowserToolInteractSession,
  dispatch: ClickDispatch
): Promise<void> => {
  await session.send('Input.dispatchMouseEvent', {
    button: dispatch.button,
    buttons: buttonBits(dispatch.button),
    clickCount: dispatch.clickCount,
    modifiers: dispatch.modifiers,
    type: 'mousePressed',
    x: dispatch.centreX,
    y: dispatch.centreY,
  });
  await session.send('Input.dispatchMouseEvent', {
    button: dispatch.button,
    buttons: 0,
    clickCount: dispatch.clickCount,
    modifiers: dispatch.modifiers,
    type: 'mouseReleased',
    x: dispatch.centreX,
    y: dispatch.centreY,
  });
};

interface KeyStroke {
  readonly code: string;
  readonly key: string;
  readonly keyCode: number;
  /** The character sits on the key's shifted position, so Shift must be held. */
  readonly shift?: true;
  readonly text?: string;
}

const NAMED_KEYS = new Map<string, KeyStroke>([
  ['ArrowDown', { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 }],
  ['ArrowLeft', { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 }],
  ['ArrowRight', { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 }],
  ['ArrowUp', { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 }],
  ['Backspace', { code: 'Backspace', key: 'Backspace', keyCode: 8 }],
  ['Delete', { code: 'Delete', key: 'Delete', keyCode: 46 }],
  ['End', { code: 'End', key: 'End', keyCode: 35 }],
  ['Enter', { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' }],
  ['Escape', { code: 'Escape', key: 'Escape', keyCode: 27 }],
  ['Home', { code: 'Home', key: 'Home', keyCode: 36 }],
  ['PageDown', { code: 'PageDown', key: 'PageDown', keyCode: 34 }],
  ['PageUp', { code: 'PageUp', key: 'PageUp', keyCode: 33 }],
  ['Space', { code: 'Space', key: ' ', keyCode: 32, text: ' ' }],
  ['Tab', { code: 'Tab', key: 'Tab', keyCode: 9 }],
]);

/**
 * US-layout descriptions for printable punctuation, from Playwright's own
 * keyboard layout. Reusing the character's ASCII code as the virtual key code
 * collided with the control keys (`'.'` -> 46 = Delete, `'('` -> 40 =
 * ArrowDown), so the browser discarded the key and the character was silently
 * dropped. Shifted symbols carry the shift bit that produces them.
 */
const PRINTABLE_KEY_STROKES = new Map<string, KeyStroke>([
  [' ', { code: 'Space', key: ' ', keyCode: 32, text: ' ' }],
  ['!', { code: 'Digit1', key: '!', keyCode: 49, shift: true, text: '!' }],
  ['"', { code: 'Quote', key: '"', keyCode: 222, shift: true, text: '"' }],
  ['#', { code: 'Digit3', key: '#', keyCode: 51, shift: true, text: '#' }],
  ['$', { code: 'Digit4', key: '$', keyCode: 52, shift: true, text: '$' }],
  ['%', { code: 'Digit5', key: '%', keyCode: 53, shift: true, text: '%' }],
  ['&', { code: 'Digit7', key: '&', keyCode: 55, shift: true, text: '&' }],
  ["'", { code: 'Quote', key: "'", keyCode: 222, text: "'" }],
  ['(', { code: 'Digit9', key: '(', keyCode: 57, shift: true, text: '(' }],
  [')', { code: 'Digit0', key: ')', keyCode: 48, shift: true, text: ')' }],
  ['*', { code: 'Digit8', key: '*', keyCode: 56, shift: true, text: '*' }],
  ['+', { code: 'Equal', key: '+', keyCode: 187, shift: true, text: '+' }],
  [',', { code: 'Comma', key: ',', keyCode: 188, text: ',' }],
  ['-', { code: 'Minus', key: '-', keyCode: 189, text: '-' }],
  ['.', { code: 'Period', key: '.', keyCode: 190, text: '.' }],
  ['/', { code: 'Slash', key: '/', keyCode: 191, text: '/' }],
  [':', { code: 'Semicolon', key: ':', keyCode: 186, shift: true, text: ':' }],
  [';', { code: 'Semicolon', key: ';', keyCode: 186, text: ';' }],
  ['<', { code: 'Comma', key: '<', keyCode: 188, shift: true, text: '<' }],
  ['=', { code: 'Equal', key: '=', keyCode: 187, text: '=' }],
  ['>', { code: 'Period', key: '>', keyCode: 190, shift: true, text: '>' }],
  ['?', { code: 'Slash', key: '?', keyCode: 191, shift: true, text: '?' }],
  ['@', { code: 'Digit2', key: '@', keyCode: 50, shift: true, text: '@' }],
  ['[', { code: 'BracketLeft', key: '[', keyCode: 219, text: '[' }],
  ['\\', { code: 'Backslash', key: '\\', keyCode: 220, text: '\\' }],
  [']', { code: 'BracketRight', key: ']', keyCode: 221, text: ']' }],
  ['^', { code: 'Digit6', key: '^', keyCode: 54, shift: true, text: '^' }],
  ['_', { code: 'Minus', key: '_', keyCode: 189, shift: true, text: '_' }],
  ['`', { code: 'Backquote', key: '`', keyCode: 192, text: '`' }],
  ['{', { code: 'BracketLeft', key: '{', keyCode: 219, shift: true, text: '{' }],
  ['|', { code: 'Backslash', key: '|', keyCode: 220, shift: true, text: '|' }],
  ['}', { code: 'BracketRight', key: '}', keyCode: 221, shift: true, text: '}' }],
  ['~', { code: 'Backquote', key: '~', keyCode: 192, shift: true, text: '~' }],
]);

const modifierKeyStroke = (modifier: ModifierName): KeyStroke => {
  switch (modifier) {
    case 'Alt': {
      return { code: 'AltLeft', key: 'Alt', keyCode: 18 };
    }
    case 'Meta': {
      return { code: 'MetaLeft', key: 'Meta', keyCode: 91 };
    }
    case 'Shift': {
      return { code: 'ShiftLeft', key: 'Shift', keyCode: 16 };
    }
    case 'Control':
    case 'ControlOrMeta': {
      return { code: 'ControlLeft', key: 'Control', keyCode: 17 };
    }
  }
};

const isModifierName = (value: string): value is ModifierName =>
  modifierSchema.safeParse(value).success;

const keyStrokeFor = (name: string): KeyStroke | undefined => {
  const named = NAMED_KEYS.get(name);

  if (named !== undefined) {
    return named;
  }

  const printable = PRINTABLE_KEY_STROKES.get(name);

  if (printable !== undefined) {
    return printable;
  }

  if (name.length !== 1) {
    return undefined;
  }

  const upper = name.toUpperCase();

  if (/[A-Z]/u.test(upper)) {
    return { code: `Key${upper}`, key: name, keyCode: upper.codePointAt(0) ?? 0, text: name };
  }

  if (/[0-9]/u.test(upper)) {
    return { code: `Digit${upper}`, key: name, keyCode: upper.codePointAt(0) ?? 0, text: name };
  }

  // A character the US layout cannot type (e.g. a non-ASCII letter) is not a key stroke.
  return undefined;
};

/** The modifiers a key event carries: the chord's plus the stroke's own Shift. */
const strokeModifiers = (stroke: KeyStroke, modifiers: number): number =>
  stroke.shift === true ? modifiers | MODIFIER_BITS.Shift : modifiers;

const dispatchKeyDown = async (
  session: BrowserToolInteractSession,
  stroke: KeyStroke,
  modifiers: number
): Promise<void> => {
  await session.send('Input.dispatchKeyEvent', {
    code: stroke.code,
    key: stroke.key,
    modifiers: strokeModifiers(stroke, modifiers),
    type: 'keyDown',
    windowsVirtualKeyCode: stroke.keyCode,
    ...(stroke.text === undefined ? {} : { text: stroke.text, unmodifiedText: stroke.text }),
  });
};

const dispatchKeyUp = async (
  session: BrowserToolInteractSession,
  stroke: KeyStroke,
  modifiers: number
): Promise<void> => {
  await session.send('Input.dispatchKeyEvent', {
    code: stroke.code,
    key: stroke.key,
    modifiers: strokeModifiers(stroke, modifiers),
    type: 'keyUp',
    windowsVirtualKeyCode: stroke.keyCode,
  });
};

const dispatchKeyStroke = async (
  session: BrowserToolInteractSession,
  stroke: KeyStroke,
  modifiers: number
): Promise<void> => {
  await dispatchKeyDown(session, stroke, modifiers);
  await dispatchKeyUp(session, stroke, modifiers);
};

/**
 * Dispatches a key chord with the metadata the browser needs to type a
 * printable character (`code`, `key`, `windowsVirtualKeyCode`, `text`), holding
 * the chord's modifiers around the final key. Shared with the run-code
 * `page.press` facade, which needs the same metadata.
 */
export const pressKeyChord = async (
  session: BrowserToolInteractSession,
  chord: string
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> => {
  const parts = chord.split('+');
  const keyName = parts.at(-1) ?? '';
  const modifierNames = parts.slice(0, -1);

  if (keyName === '' || !modifierNames.every(name => isModifierName(name))) {
    return {
      error: `Unknown key "${chord}". Use a key name such as Enter, ArrowLeft, or Control+A, or a single character.`,
      ok: false,
    };
  }

  const stroke = keyStrokeFor(keyName);

  if (stroke === undefined) {
    return {
      error: `Unknown key "${chord}". Use a key name such as Enter, ArrowLeft, or Control+A, or a single character.`,
      ok: false,
    };
  }

  let activeModifiers = 0;

  for (const modifier of modifierNames) {
    activeModifiers |= modifierBits(modifier);
    // eslint-disable-next-line no-await-in-loop -- Modifier keys must go down in order before the chord's key
    await dispatchKeyDown(session, modifierKeyStroke(modifier), activeModifiers);
  }

  await dispatchKeyStroke(session, stroke, activeModifiers);

  for (const modifier of modifierNames.toReversed()) {
    activeModifiers &= ~modifierBits(modifier);
    // eslint-disable-next-line no-await-in-loop -- Modifier keys must come up in reverse order after the chord's key
    await dispatchKeyUp(session, modifierKeyStroke(modifier), activeModifiers);
  }

  return { ok: true };
};

const TARGET_ATTRIBUTE = 'data-kilo-tool-target';
let targetTagCounter = 0;

interface PageHelperTarget {
  readonly cleanup?: () => Promise<void>;
  readonly selector: string;
}

type PageHelperTargetResult =
  | { readonly ok: true; readonly target: PageHelperTarget }
  | { readonly ok: false; readonly error: string };

const nodeIdsResponseSchema = z.object({ nodeIds: z.array(z.number()) });
const nodeObjectSchema = z.object({ object: z.object({ objectId: z.string().optional() }) });
const callFunctionResponseSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
});

/**
 * Proves the frontend node is still attached to the document. A node removed
 * without a navigation keeps its backend id, still resolves to a remote object
 * and still accepts `DOM.setAttributeValue`, so tagging alone cannot tell a live
 * ref from a stale one and the page helper would wait for a selector it can
 * never find. Only the node's own `isConnected` distinguishes them.
 */
const nodeIsConnected = async (
  session: BrowserToolInteractSession,
  nodeId: number
): Promise<boolean> => {
  const resolved = await sendOrUndefined(session, 'DOM.resolveNode', { nodeId });
  const object = nodeObjectSchema.safeParse(resolved);
  const objectId = object.success ? object.data.object.objectId : undefined;

  if (objectId === undefined) {
    return false;
  }

  try {
    const called = await sendOrUndefined(session, 'Runtime.callFunctionOn', {
      functionDeclaration: 'function () { return this.isConnected === true; }',
      objectId,
      returnByValue: true,
    });
    const connected = callFunctionResponseSchema.safeParse(called);

    return connected.success && connected.data.result.value === true;
  } finally {
    try {
      // Release the remote object the resolve created; a navigation may already have destroyed its context.
      await session.send('Runtime.releaseObject', { objectId });
    } catch {
      // The object's context is gone; the handle went with it.
    }
  }
};

/**
 * Resolves a snapshot ref to a live CSS selector by tagging the node. Selector
 * targets are used as-is. Either way the DOM-side lookup and the mutation are
 * performed by the page-helper layer (`page.waitFor`/`page.__q`/`page.fill`),
 * not by a second resolver in this module.
 */
const toPageHelperTarget = async (
  session: BrowserToolInteractSession,
  target: BrowserToolResolvedTarget
): Promise<PageHelperTargetResult> => {
  if (target.kind === 'selector') {
    return { ok: true, target: { selector: target.selector } };
  }

  const response = await sendOrUndefined(session, 'DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [target.backendNodeId],
  });
  const parsed = nodeIdsResponseSchema.safeParse(response);
  const nodeId = parsed.success ? parsed.data.nodeIds[0] : undefined;

  if (nodeId === undefined || nodeId === 0) {
    return { error: STALE_REF_ERROR, ok: false };
  }

  if (!(await nodeIsConnected(session, nodeId))) {
    return { error: STALE_REF_ERROR, ok: false };
  }

  targetTagCounter += 1;
  const value = `kilo-${String(targetTagCounter)}`;

  const tagged = await sendOrUndefined(session, 'DOM.setAttributeValue', {
    name: TARGET_ATTRIBUTE,
    nodeId,
    value,
  });

  if (tagged === undefined) {
    return { error: STALE_REF_ERROR, ok: false };
  }

  return {
    ok: true,
    target: {
      cleanup: async () => {
        try {
          await session.send('DOM.removeAttribute', { name: TARGET_ATTRIBUTE, nodeId });
        } catch {
          // The node may be gone after a navigation; the stale attribute is harmless.
        }
      },
      selector: `[${TARGET_ATTRIBUTE}="${value}"]`,
    },
  };
};

const evaluateResponseSchema = z.object({
  exceptionDetails: z
    .object({
      exception: z.object({ description: z.string().optional() }).optional(),
      text: z.string().optional(),
    })
    .optional(),
  result: z.object({ value: z.unknown().optional() }).optional(),
});

const pageHelperEnvelopeSchema = z.object({
  error: z.string().optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
});

const doneEnvelopeSchema = z.object({ done: z.literal(true), result: z.unknown().optional() });

/**
 * Runs a body script through the workflow page-helper layer and unwraps its
 * `{ done: true, result }` return value. `script` uses only the injected `page`
 * object (`waitFor`, `__q`, `fill`, `click`), so the helpers stay the single
 * DOM-side element resolver.
 */
const runPageHelperScript = async (
  session: BrowserToolInteractSession,
  script: string
): Promise<EvalTabResult> => {
  const code = buildWorkflowPageCode(script, {}, false, {});
  const response = await session.send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {${code}\n})()`,
    returnByValue: true,
  });
  const parsed = evaluateResponseSchema.safeParse(response);

  if (!parsed.success) {
    return fail('The page helper returned an unexpected response.');
  }

  const exception = parsed.data.exceptionDetails;

  if (exception !== undefined) {
    return fail(exception.exception?.description ?? exception.text ?? 'The page helper threw.');
  }

  const envelope = pageHelperEnvelopeSchema.safeParse(parsed.data.result?.value);

  if (!envelope.success) {
    return fail('The page helper returned an unexpected result.');
  }

  if (!envelope.data.ok) {
    return fail(envelope.data.error ?? 'The page helper failed.');
  }

  const done = doneEnvelopeSchema.safeParse(envelope.data.value);

  if (!done.success) {
    return fail('The page helper did not complete its action.');
  }

  const resultValue = pageHelperValueSchema.safeParse(done.data.result);

  return okValue(resultValue.success ? resultValue.data : null);
};

const buildSelectOptionScript = (selector: string, values: readonly string[]): string => `
await page.waitFor(${JSON.stringify(selector)});
const el = page.__q(${JSON.stringify(selector)});
if (!(el instanceof HTMLSelectElement)) {
  throw new Error('The target element is not a <select> element.');
}
const wanted = ${JSON.stringify(values)};
const norm = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim().toLowerCase();
const options = Array.from(el.options);
const findOption = (value) =>
  options.find((option) => norm(option.value) === norm(value) || norm(option.textContent) === norm(value));
const unmatched = wanted.filter((value) => findOption(value) === undefined);
if (unmatched.length > 0) {
  const labels = options.map((option) => (option.textContent ?? '').trim()).filter(Boolean);
  throw new Error(
    'No option matches ' + unmatched.map((value) => '"' + value + '"').join(', ') +
    '. Available options: ' + labels.join(', ').slice(0, 300)
  );
}
const matched = wanted.map((value) => findOption(value));
for (const option of options) {
  option.selected = matched.includes(option);
}
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { done: true, result: ${JSON.stringify(values)} };
`;

const clickArgsSchema = z.object({
  button: z.enum(['left', 'right', 'middle']).optional(),
  doubleClick: z.boolean().optional(),
  element: z.string().optional(),
  modifiers: z.array(modifierSchema).optional(),
  target: z.string().min(1),
});

const handleClick = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = clickArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_click', parsed.error.message);
  }

  const resolved = await resolveTargetOrError(session, parsed.data.target);

  if (!resolved.ok) {
    return fail(resolved.error);
  }

  const centre = await resolveCentre(session, resolved.target);

  if (!centre.ok) {
    return fail(centre.error);
  }

  const button: MouseButton = parsed.data.button ?? 'left';
  const modifiers = modifierMask(parsed.data.modifiers);
  const clickCounts = parsed.data.doubleClick === true ? [1, 2] : [1];

  for (const clickCount of clickCounts) {
    // eslint-disable-next-line no-await-in-loop -- Ordered press/release pairs; a double click must complete the first click before the second
    await dispatchClick(session, {
      button,
      centreX: centre.centreX,
      centreY: centre.centreY,
      clickCount,
      modifiers,
    });
  }

  const label = parsed.data.element ?? parsed.data.target;
  const qualifier = parsed.data.doubleClick === true ? ' (double click)' : '';

  return ok(`Clicked "${label}" with the ${button} button${qualifier}.`);
};

const typeArgsSchema = z.object({
  element: z.string().optional(),
  slowly: z.boolean().optional(),
  submit: z.boolean().optional(),
  target: z.string().min(1),
  text: z.string(),
});

const handleType = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = typeArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_type', parsed.error.message);
  }

  const resolved = await resolveTargetOrError(session, parsed.data.target);

  if (!resolved.ok) {
    return fail(resolved.error);
  }

  const centre = await resolveCentre(session, resolved.target);

  if (!centre.ok) {
    return fail(centre.error);
  }

  await session.send('DOM.focus', nodeParams(resolved.target));

  if (parsed.data.slowly === true) {
    for (const character of parsed.data.text) {
      const stroke = keyStrokeFor(character);

      // Playwright inserts a character the US layout cannot type (e.g. 'é').
      // eslint-disable-next-line no-await-in-loop -- Characters must land in order for key handlers
      await (stroke === undefined
        ? session.send('Input.insertText', { text: character })
        : dispatchKeyStroke(session, stroke, 0));
    }
  } else {
    await session.send('Input.insertText', { text: parsed.data.text });
  }

  if (parsed.data.submit === true) {
    await pressKeyChord(session, 'Enter');
  }

  const label = parsed.data.element ?? parsed.data.target;

  return ok(
    `Typed ${String(parsed.data.text.length)} characters into "${label}"${parsed.data.submit === true ? ' and submitted' : ''}.`
  );
};

const hoverArgsSchema = z.object({
  element: z.string().optional(),
  target: z.string().min(1),
});

/** Lets a hover-triggered menu open before the next tool call reads the page. */
const HOVER_SETTLE_MS = 100;

const handleHover = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = hoverArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_hover', parsed.error.message);
  }

  const resolved = await resolveTargetOrError(session, parsed.data.target);

  if (!resolved.ok) {
    return fail(resolved.error);
  }

  const centre = await resolveCentre(session, resolved.target);

  if (!centre.ok) {
    return fail(centre.error);
  }

  await session.send('Input.dispatchMouseEvent', {
    button: 'none',
    buttons: 0,
    modifiers: 0,
    type: 'mouseMoved',
    x: centre.centreX,
    y: centre.centreY,
  });

  // eslint-disable-next-line promise/avoid-new -- a plain settle delay has no promise-returning primitive to defer to
  await new Promise<void>(resolve => {
    setTimeout(resolve, HOVER_SETTLE_MS);
  });

  const label = parsed.data.element ?? parsed.data.target;

  return ok(`Hovered over "${label}".`);
};

const dragArgsSchema = z.object({
  endElement: z.string().optional(),
  endTarget: z.string().min(1),
  startElement: z.string().optional(),
  startTarget: z.string().min(1),
});

const DRAG_STEPS = 4;

const handleDrag = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = dragArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_drag', parsed.error.message);
  }

  const start = await resolveTargetOrError(session, parsed.data.startTarget);

  if (!start.ok) {
    return fail(start.error);
  }

  const end = await resolveTargetOrError(session, parsed.data.endTarget);

  if (!end.ok) {
    return fail(end.error);
  }

  const startCentre = await resolveCentre(session, start.target);

  if (!startCentre.ok) {
    return fail(startCentre.error);
  }

  const endCentre = await resolveCentre(session, end.target);

  if (!endCentre.ok) {
    return fail(endCentre.error);
  }

  await session.send('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 0,
    modifiers: 0,
    type: 'mouseMoved',
    x: startCentre.centreX,
    y: startCentre.centreY,
  });
  await session.send('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 0,
    type: 'mousePressed',
    x: startCentre.centreX,
    y: startCentre.centreY,
  });

  for (let step = 1; step <= DRAG_STEPS; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- Intermediate moves must arrive in order for the drop target to track the drag
    await session.send('Input.dispatchMouseEvent', {
      button: 'left',
      buttons: 1,
      modifiers: 0,
      type: 'mouseMoved',
      x: startCentre.centreX + ((endCentre.centreX - startCentre.centreX) * step) / DRAG_STEPS,
      y: startCentre.centreY + ((endCentre.centreY - startCentre.centreY) * step) / DRAG_STEPS,
    });
  }

  await session.send('Input.dispatchMouseEvent', {
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers: 0,
    type: 'mouseReleased',
    x: endCentre.centreX,
    y: endCentre.centreY,
  });

  const startLabel = parsed.data.startElement ?? parsed.data.startTarget;
  const endLabel = parsed.data.endElement ?? parsed.data.endTarget;

  return ok(`Dragged from "${startLabel}" to "${endLabel}".`);
};

const dropArgsSchema = z.object({
  data: z.record(z.string(), z.string()).optional(),
  element: z.string().optional(),
  paths: z.array(z.string()).optional(),
  target: z.string().min(1),
});

/** Upstream rule, verbatim: neither a file list nor a MIME payload makes a drop. */
const DROP_REQUIRES_PAYLOAD_ERROR = 'At least one of "paths" or "data" must be provided.';

const handleDrop = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = dropArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_drop', parsed.error.message);
  }

  const paths = parsed.data.paths ?? [];
  const data = parsed.data.data ?? {};

  if (paths.length === 0 && Object.keys(data).length === 0) {
    return fail(DROP_REQUIRES_PAYLOAD_ERROR);
  }

  const resolved = await resolveTargetOrError(session, parsed.data.target);

  if (!resolved.ok) {
    return fail(resolved.error);
  }

  const centre = await resolveCentre(session, resolved.target);

  if (!centre.ok) {
    return fail(centre.error);
  }

  const dragData = {
    dragOperationsMask: 1,
    files: paths,
    items: Object.entries(data).map(([mimeType, value]) => ({ data: value, mimeType })),
  };

  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    // eslint-disable-next-line no-await-in-loop -- The drag phases must reach the page in order
    await session.send('Input.dispatchDragEvent', {
      data: dragData,
      type,
      x: centre.centreX,
      y: centre.centreY,
    });
  }

  const label = parsed.data.element ?? parsed.data.target;
  const payload =
    paths.length > 0
      ? `${String(paths.length)} file(s)`
      : `${String(Object.keys(data).length)} data type(s)`;

  return ok(`Dropped ${payload} onto "${label}".`);
};

const formFieldSchema = z.object({
  element: z.string().optional(),
  name: z.string(),
  target: z.string().min(1),
  type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']),
  value: z.string(),
});

const fillFormArgsSchema = z.object({ fields: z.array(formFieldSchema).min(1) });

const readCheckedSchema = z.boolean();

interface FieldOutcome {
  readonly detail: string;
  readonly name: string;
  readonly ok: boolean;
}

const fillField = async (
  field: z.infer<typeof formFieldSchema>,
  session: BrowserToolInteractSession
): Promise<FieldOutcome> => {
  const resolved = await resolveTargetOrError(session, field.target);

  if (!resolved.ok) {
    return { detail: resolved.error, name: field.name, ok: false };
  }

  if (field.type === 'checkbox' || field.type === 'radio') {
    const helper = await toPageHelperTarget(session, resolved.target);

    if (!helper.ok) {
      return { detail: helper.error, name: field.name, ok: false };
    }

    try {
      const checkedResult = await runPageHelperScript(
        session,
        `await page.waitFor(${JSON.stringify(helper.target.selector)});\nreturn { done: true, result: Boolean(page.__q(${JSON.stringify(helper.target.selector)}).checked) };`
      );

      if (!checkedResult.ok) {
        return { detail: checkedResult.error, name: field.name, ok: false };
      }

      const checked = readCheckedSchema.parse(checkedResult.value);
      const desired = field.value === 'true';

      if (checked !== desired) {
        const centre = await resolveCentre(session, resolved.target);

        if (!centre.ok) {
          return { detail: centre.error, name: field.name, ok: false };
        }

        await dispatchClick(session, {
          button: 'left',
          centreX: centre.centreX,
          centreY: centre.centreY,
          clickCount: 1,
          modifiers: 0,
        });
      }

      return { detail: `set to ${field.value}`, name: field.name, ok: true };
    } finally {
      await helper.target.cleanup?.();
    }
  }

  const helper = await toPageHelperTarget(session, resolved.target);

  if (!helper.ok) {
    return { detail: helper.error, name: field.name, ok: false };
  }

  try {
    const result = await runPageHelperScript(
      session,
      `await page.waitFor(${JSON.stringify(helper.target.selector)});\nawait page.fill(${JSON.stringify(helper.target.selector)}, ${JSON.stringify(field.value)});\nreturn { done: true, result: true };`
    );

    return result.ok
      ? { detail: `filled with "${field.value}"`, name: field.name, ok: true }
      : { detail: result.error, name: field.name, ok: false };
  } finally {
    await helper.target.cleanup?.();
  }
};

const handleFillForm = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = fillFormArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_fill_form', parsed.error.message);
  }

  const outcomes: FieldOutcome[] = [];

  for (const field of parsed.data.fields) {
    // eslint-disable-next-line no-await-in-loop -- Fields fill in the model's order and each outcome is reported
    outcomes.push(await fillField(field, session));
  }

  const lines = outcomes.map(
    outcome => `${outcome.name}: ${outcome.ok ? 'ok' : 'failed'} — ${outcome.detail}`
  );
  const failedCount = outcomes.filter(outcome => !outcome.ok).length;

  return failedCount === 0
    ? ok(`Filled ${String(outcomes.length)} field(s).\n${lines.join('\n')}`)
    : fail(
        `${String(failedCount)} of ${String(outcomes.length)} field(s) failed.\n${lines.join('\n')}`
      );
};

const selectOptionArgsSchema = z.object({
  element: z.string().optional(),
  target: z.string().min(1),
  values: z.array(z.string()).min(1),
});

const handleSelectOption = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = selectOptionArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_select_option', parsed.error.message);
  }

  const resolved = await resolveTargetOrError(session, parsed.data.target);

  if (!resolved.ok) {
    return fail(resolved.error);
  }

  const helper = await toPageHelperTarget(session, resolved.target);

  if (!helper.ok) {
    return fail(helper.error);
  }

  try {
    const result = await runPageHelperScript(
      session,
      buildSelectOptionScript(helper.target.selector, parsed.data.values)
    );

    if (!result.ok) {
      return result;
    }

    const label = parsed.data.element ?? parsed.data.target;

    return ok(
      `Selected ${parsed.data.values.map(value => `"${value}"`).join(', ')} in "${label}".`
    );
  } finally {
    await helper.target.cleanup?.();
  }
};

const pressKeyArgsSchema = z.object({ key: z.string().min(1) });

const handlePressKey = async (
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const parsed = pressKeyArgsSchema.safeParse(args);

  if (!parsed.success) {
    return invalidArguments('browser_press_key', parsed.error.message);
  }

  const result = await pressKeyChord(session, parsed.data.key.trim());

  return result.ok ? ok(`Pressed "${parsed.data.key.trim()}".`) : fail(result.error);
};

/**
 * Runs one interaction tool against the session. `name` accepts the upstream
 * name (`browser_click`) or the model-facing `kilo_browser_click`; `args` are
 * the model's verbatim arguments, parsed per tool at this boundary.
 */
export const runInteractBrowserTool = async (
  name: string,
  args: Record<string, unknown>,
  session: BrowserToolInteractSession
): Promise<EvalTabResult> => {
  const upstreamName = toUpstreamToolName(name);

  try {
    switch (upstreamName) {
      case 'browser_click': {
        return await handleClick(args, session);
      }
      case 'browser_drag': {
        return await handleDrag(args, session);
      }
      case 'browser_drop': {
        return await handleDrop(args, session);
      }
      case 'browser_fill_form': {
        return await handleFillForm(args, session);
      }
      case 'browser_hover': {
        return await handleHover(args, session);
      }
      case 'browser_press_key': {
        return await handlePressKey(args, session);
      }
      case 'browser_select_option': {
        return await handleSelectOption(args, session);
      }
      case 'browser_type': {
        return await handleType(args, session);
      }
      default: {
        return fail(`${name} is not an interaction tool.`);
      }
    }
  } catch (error) {
    return fail(
      `${upstreamName} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
