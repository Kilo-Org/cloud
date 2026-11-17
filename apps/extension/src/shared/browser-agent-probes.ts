import { z } from 'zod';
import { classifyFormField } from './browser-agent-checks';
import type { BrowserSensitiveProbe } from './browser-agent-checks';
import type { BrowserToolPageSession } from './browser-tool-snapshot';

/**
 * Page probes an agent call runs at action time: what the page hides, which
 * sensitive field values it must mask, and whether the element a call targets
 * is a password/payment/one-time-code control (or submits a card form).
 *
 * Every probe runs in an isolated world: page script cannot see or hook it,
 * and it cannot reach extension-privileged contexts because it is still the
 * page's own DOM, evaluated through the tab's debugger attachment.
 */

type ProbeSession = Pick<BrowserToolPageSession, 'send' | 'resolveTarget'>;

const ISOLATED_WORLD_NAME = 'kilo-agent-probe';

const runtimeEvaluateSchema = z.object({
  result: z.object({ value: z.unknown().optional() }).optional(),
});

const executionContextSchema = z.object({ executionContextId: z.number().optional() });

/**
 * An isolated-world execution context for one frame. A frame that is gone
 * (racing navigation) yields `undefined` and the caller treats its probe as
 * empty rather than failing the tool.
 */
const frameExecutionContext = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<number | undefined> => {
  try {
    const parsed = executionContextSchema.safeParse(
      await session.send('Page.createIsolatedWorld', {
        frameId,
        grantUniveralAccess: false,
        worldName: ISOLATED_WORLD_NAME,
      })
    );

    return parsed.success ? parsed.data.executionContextId : undefined;
  } catch {
    return undefined;
  }
};

const evaluateProbeJson = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  expression: string,
  frameId?: string
): Promise<unknown> => {
  const contextId =
    frameId === undefined ? undefined : await frameExecutionContext(session, frameId);

  if (frameId !== undefined && contextId === undefined) {
    return undefined;
  }

  const parsed = runtimeEvaluateSchema.safeParse(
    await session.send('Runtime.evaluate', {
      awaitPromise: false,
      expression,
      returnByValue: true,
      ...(contextId === undefined ? {} : { contextId }),
    })
  );
  const value = parsed.success ? parsed.data.result?.value : undefined;

  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * Text the page hides from a human: `opacity:0`, a zero-size box, a box fully
 * outside the document's scroll area, `aria-hidden`, `display:none`,
 * `visibility:hidden`, or text whose colour equals its background. Returns the
 * hidden text nodes' collapsed text, which the snapshot renderer matches
 * against its `- text:` leaves.
 */
export const HIDDEN_TEXT_PROBE_EXPRESSION = `(() => {
  var HIDDEN = [];
  var seen = typeof Set === 'function' ? new Set() : null;
  var collapse = function (value) { return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim(); };
  var add = function (value) { var text = collapse(value); if (text === '') { return; } if (seen !== null) { if (seen.has(text)) { return; } seen.add(text); } HIDDEN.push(text); };
  var colorEqualsBackground = function (element) {
    var own = getComputedStyle(element);
    var color = own.color;
    var node = element;
    while (node !== null && node.nodeType === 1) {
      var style = getComputedStyle(node);
      var background = style.backgroundColor;
      var transparent = background === '' || background === 'transparent' || /rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*0\\s*\\)/.test(background);
      if (!transparent) { return color === background; }
      node = node.parentElement;
    }
    return false;
  };
  var isHiddenElement = function (element) {
    if (element.closest('[aria-hidden="true"]') !== null) { return true; }
    var style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { return true; }
    var rects = element.getClientRects();
    if (rects.length === 0) { return true; }
    var rect = rects[0];
    if (rect.width === 0 || rect.height === 0) { return true; }
    var doc = document.documentElement;
    var scrollHeight = Math.max(doc ? doc.scrollHeight : 0, window.innerHeight || 0);
    var scrollWidth = Math.max(doc ? doc.scrollWidth : 0, window.innerWidth || 0);
    var left = rect.left + (window.scrollX || 0);
    var top = rect.top + (window.scrollY || 0);
    if (left + rect.width < 0 || top + rect.height < 0) { return true; }
    if (left > scrollWidth || top > scrollHeight) { return true; }
    return colorEqualsBackground(element);
  };
  var root = document.body || document.documentElement;
  if (root === null) { return JSON.stringify({ hidden: [] }); }
  if (isHiddenElement(root)) { add(root.textContent); return JSON.stringify({ hidden: HIDDEN }); }
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var node = walker.nextNode();
  while (node !== null) {
    var parent = node.parentElement;
    if (parent !== null && collapse(node.data) !== '' && isHiddenElement(parent)) { add(node.data); }
    node = walker.nextNode();
  }
  return JSON.stringify({ hidden: HIDDEN });
})()`;

const hiddenTextPayloadSchema = z.object({ hidden: z.array(z.string()).optional() });

/** The hidden text one frame hides, as collapsed strings. */
export const readFrameHiddenText = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<ReadonlySet<string>> => {
  try {
    const payload = hiddenTextPayloadSchema.safeParse(
      await evaluateProbeJson(session, HIDDEN_TEXT_PROBE_EXPRESSION, frameId)
    );

    return new Set(
      (payload.success ? (payload.data.hidden ?? []) : []).filter(text => text !== '')
    );
  } catch {
    return new Set();
  }
};

/**
 * The current values of password, one-time-code and payment fields in one
 * frame, so a value that leaked into tool text is replaced with `[masked]`.
 */
export const SENSITIVE_VALUES_PROBE_EXPRESSION = `(() => {
  var kindOf = function (input) {
    var type = String(input.type || '').toLowerCase();
    if (type === 'password') { return 'password'; }
    var autocomplete = String(input.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    for (var index = 0; index < autocomplete.length; index += 1) {
      var token = autocomplete[index];
      if (token === 'one-time-code') { return 'one-time-code'; }
      if (token.indexOf('cc-') === 0) { return 'payment'; }
    }
    var name = String(input.getAttribute('name') || '').toLowerCase();
    if (/(^|[-_])(cc|card)([-_]|$)/.test(name) || name === 'cardnumber') { return 'payment'; }
    return null;
  };
  var values = [];
  var inputs = document.querySelectorAll('input, textarea, select');
  for (var index = 0; index < inputs.length; index += 1) {
    var input = inputs[index];
    if (kindOf(input) === null) { continue; }
    var value = String(input.value == null ? '' : input.value);
    if (value !== '') { values.push(value); }
  }
  return JSON.stringify({ values: values });
})()`;

const sensitiveValuesPayloadSchema = z.object({ values: z.array(z.string()).optional() });

export const readFrameSensitiveValues = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<readonly string[]> => {
  try {
    const payload = sensitiveValuesPayloadSchema.safeParse(
      await evaluateProbeJson(session, SENSITIVE_VALUES_PROBE_EXPRESSION, frameId)
    );

    return (payload.success ? (payload.data.values ?? []) : []).filter(value => value !== '');
  } catch {
    return [];
  }
};

/**
 * Classifies the element a call targets (and, for a submit control, the form
 * it submits). Runs in the element's own context, so it sees the frame the
 * element lives in and the frame's own forms.
 */
export const SENSITIVE_TARGET_PROBE_FUNCTION = `function () {
  var element = this;
  var kindOf = function (input) {
    var type = String(input.type || '').toLowerCase();
    if (type === 'password') { return 'password'; }
    var autocomplete = String(input.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    for (var index = 0; index < autocomplete.length; index += 1) {
      var token = autocomplete[index];
      if (token === 'one-time-code') { return 'one-time-code'; }
      if (token.indexOf('cc-') === 0) { return 'payment'; }
    }
    var name = String(input.getAttribute('name') || '').toLowerCase();
    if (/(^|[-_])(cc|card)([-_]|$)/.test(name) || name === 'cardnumber') { return 'payment'; }
    return null;
  };
  var fields = [];
  var ownKind = kindOf(element);
  if (ownKind !== null) { fields.push({ kind: ownKind }); }
  var form = element.closest ? element.closest('form') : null;
  var tag = String(element.tagName || '').toUpperCase();
  var role = element.getAttribute ? String(element.getAttribute('role') || '') : '';
  var isSubmit = tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|image)$/i.test(String(element.type || ''))) || (role === 'button' && form !== null);
  var paymentFormSubmit = false;
  if (isSubmit && form !== null) {
    var inputs = form.querySelectorAll('input, select, textarea');
    for (var index = 0; index < inputs.length; index += 1) {
      if (kindOf(inputs[index]) === 'payment') { paymentFormSubmit = true; break; }
    }
  }
  return JSON.stringify({ fields: fields, paymentFormSubmit: paymentFormSubmit });
}`;

const sensitiveProbePayloadSchema = z.object({
  fields: z.array(z.object({ kind: z.enum(['one-time-code', 'password', 'payment']) })).optional(),
  paymentFormSubmit: z.boolean().optional(),
});

/**
 * Reads the sensitive state of one target element. A target that no longer
 * resolves reads as an empty probe: the tool itself then reports its own
 * "no element" error, which is the accurate outcome.
 */
export const readSensitiveProbeForTarget = async (
  session: ProbeSession,
  target: string | undefined
): Promise<BrowserSensitiveProbe> => {
  if (target === undefined || target === '') {
    return { fields: [], paymentFormSubmit: false };
  }

  try {
    const resolved = await session.resolveTarget(target);

    if (resolved === undefined) {
      return { fields: [], paymentFormSubmit: false };
    }

    const resolveSchema = z.object({
      object: z.object({ objectId: z.string().optional() }).optional(),
    });
    const resolvedNode = resolveSchema.safeParse(
      await session.send(
        'DOM.resolveNode',
        resolved.kind === 'ref'
          ? { backendNodeId: resolved.backendNodeId }
          : { nodeId: resolved.nodeId }
      )
    );
    const objectId = resolvedNode.success ? resolvedNode.data.object?.objectId : undefined;

    if (objectId === undefined) {
      return { fields: [], paymentFormSubmit: false };
    }

    const probe = await session.send('Runtime.callFunctionOn', {
      functionDeclaration: SENSITIVE_TARGET_PROBE_FUNCTION,
      objectId,
      returnByValue: true,
    });
    const value = runtimeEvaluateSchema.safeParse(probe).success
      ? runtimeEvaluateSchema.parse(probe).result?.value
      : undefined;

    if (typeof value !== 'string') {
      return { fields: [], paymentFormSubmit: false };
    }

    const payload = sensitiveProbePayloadSchema.safeParse(JSON.parse(value));

    if (!payload.success) {
      return { fields: [], paymentFormSubmit: false };
    }

    return {
      fields: payload.data.fields ?? [],
      paymentFormSubmit: payload.data.paymentFormSubmit === true,
    };
  } catch {
    return { fields: [], paymentFormSubmit: false };
  }
};

/** The same classification the probe applies, for a tool call that carries field metadata directly. */
export const classifySensitiveFields = (
  fields: readonly {
    readonly autocomplete?: string;
    readonly name?: string;
    readonly type?: string;
  }[]
): BrowserSensitiveProbe => {
  const kinds = fields
    .map(field => classifyFormField(field))
    .filter((kind): kind is NonNullable<typeof kind> => kind !== undefined);

  return { fields: kinds.map(kind => ({ kind })), paymentFormSubmit: false };
};

/** The tools whose target element decides whether the step is sensitive. */
const TARGETED_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_drag',
  'browser_fill_form',
  'browser_press_key',
  'browser_select_option',
  'browser_type',
]);

/**
 * The targets a call will type into or click. `browser_fill_form` carries one
 * target per field; every other targeted tool has a single `element`.
 */
export const sensitiveTargetsOf = (
  toolName: string,
  args: Record<string, unknown>
): readonly string[] => {
  if (!TARGETED_TOOLS.has(toolName)) {
    return [];
  }

  const targets: string[] = [];

  for (const key of ['element', 'target', 'ref', 'selector']) {
    const value = args[key];

    if (typeof value === 'string' && value !== '') {
      targets.push(value);
    }
  }

  const fields = args['fields'];

  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (typeof field === 'object' && field !== null) {
        const ref = 'ref' in field ? field.ref : undefined;
        const selector = 'selector' in field ? field.selector : undefined;
        const target =
          typeof ref === 'string' ? ref : typeof selector === 'string' ? selector : undefined;

        if (target !== undefined && target !== '') {
          targets.push(target);
        }
      }
    }
  }

  return targets;
};
