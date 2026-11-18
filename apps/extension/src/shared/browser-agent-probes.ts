/* eslint-disable max-lines -- The probe expressions are page-side source strings; splitting them from the parsers that read them hurts review. */
import { z } from 'zod';
import { SENSITIVE_REASON, sensitiveReasonForField } from './browser-agent-checks';
import type { BrowserSensitiveField } from './browser-agent-checks';
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
export const frameExecutionContext = async (
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

const frameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string() }) }),
});

const describeNodeSchema = z.object({
  node: z.object({ frameId: z.string().optional() }).optional(),
});

/** The frame a resolved target lives in, so the probe can run in that frame's isolated world. */
const targetFrameId = async (
  session: ProbeSession,
  resolved:
    | { readonly kind: 'ref'; readonly backendNodeId: number }
    | { readonly kind: 'selector'; readonly nodeId: number }
): Promise<string | undefined> => {
  try {
    const parsed = describeNodeSchema.safeParse(
      await session.send(
        'DOM.describeNode',
        resolved.kind === 'ref'
          ? { backendNodeId: resolved.backendNodeId }
          : { nodeId: resolved.nodeId }
      )
    );

    return parsed.success ? parsed.data.node?.frameId : undefined;
  } catch {
    return undefined;
  }
};

const mainFrameId = async (
  session: Pick<BrowserToolPageSession, 'send'>
): Promise<string | undefined> => {
  try {
    const parsed = frameTreeSchema.safeParse(await session.send('Page.getFrameTree'));

    return parsed.success ? parsed.data.frameTree.frame.id : undefined;
  } catch {
    return undefined;
  }
};

const probeJsonSchema = z.string();

/**
 * Runs one probe expression in a frame's isolated world and decodes the JSON
 * string it returns with the probe's own schema, so every caller reads a
 * validated payload and no `unknown` leaves this module.
 */
const readProbePayload = async <Parsed>(input: {
  readonly expression: string;
  readonly frameId: string;
  readonly schema: z.ZodType<Parsed>;
  readonly session: Pick<BrowserToolPageSession, 'send'>;
}): Promise<Parsed | undefined> => {
  const contextId = await frameExecutionContext(input.session, input.frameId);

  if (contextId === undefined) {
    return undefined;
  }

  const response = runtimeEvaluateSchema.safeParse(
    await input.session.send('Runtime.evaluate', {
      awaitPromise: false,
      contextId,
      expression: input.expression,
      returnByValue: true,
    })
  );
  const raw = probeJsonSchema.safeParse(response.success ? response.data.result?.value : undefined);

  if (!raw.success) {
    return undefined;
  }

  try {
    const parsed = input.schema.safeParse(JSON.parse(raw.data));

    return parsed.success ? parsed.data : undefined;
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
    const payload = await readProbePayload({
      expression: HIDDEN_TEXT_PROBE_EXPRESSION,
      frameId,
      schema: hiddenTextPayloadSchema,
      session,
    });

    return new Set((payload?.hidden ?? []).filter(text => text !== ''));
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
    const payload = await readProbePayload({
      expression: SENSITIVE_VALUES_PROBE_EXPRESSION,
      frameId,
      schema: sensitiveValuesPayloadSchema,
      session,
    });

    return (payload?.values ?? []).filter(value => value !== '');
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

const evaluatedObjectSchema = z.object({
  result: z.object({ objectId: z.string().optional() }).optional(),
});

const resolveObjectSchema = z.object({
  object: z.object({ objectId: z.string().optional() }).optional(),
});

const sensitiveProbePayloadSchema = z.object({
  fields: z.array(z.object({ kind: z.enum(['one-time-code', 'password', 'payment']) })),
  paymentFormSubmit: z.boolean(),
});

/** A field the probe positively identified as one of the sensitive kinds. */
type SensitiveFieldKind = BrowserSensitiveField['kind'];

/**
 * The one sensitive-step classification. `plain` is only returned for a fully
 * parsed, schema-valid probe that positively says the element is an ordinary
 * field; every other outcome is `unknown` and its caller treats it as sensitive.
 */
export type SensitiveVerdict =
  | { readonly kind: 'plain' }
  | {
      readonly kind: 'sensitive';
      /** Set when the sensitive element is a frame the page cannot read. */
      readonly frameBackendNodeId?: number | undefined;
      readonly reason: string;
    }
  | { readonly kind: 'unknown'; readonly cause: string };

const classifyField = (kind: SensitiveFieldKind): SensitiveVerdict => ({
  kind: 'sensitive',
  reason: sensitiveReasonForField(kind),
});

/** Classifies one probe payload; anything not fully understood is unknown. */
export const classifyProbeValue = (value: unknown): SensitiveVerdict => {
  const raw = probeJsonSchema.safeParse(value);

  if (!raw.success) {
    return { cause: 'the probe returned no text', kind: 'unknown' };
  }

  let parsed: unknown = undefined;

  try {
    parsed = JSON.parse(raw.data);
  } catch {
    return { cause: 'the probe returned malformed JSON', kind: 'unknown' };
  }

  const payload = sensitiveProbePayloadSchema.safeParse(parsed);

  if (!payload.success) {
    return { cause: 'the probe payload did not match its schema', kind: 'unknown' };
  }

  if (payload.data.paymentFormSubmit) {
    return { kind: 'sensitive', reason: SENSITIVE_REASON.cardFormSubmit };
  }

  const [field] = payload.data.fields ?? [];

  if (field === undefined) {
    return { kind: 'plain' };
  }

  return classifyField(field.kind);
};

/** Classifies an element held as a remote object; a failed call is unknown. */
const classifyObject = async (
  session: ProbeSession,
  objectId: string
): Promise<SensitiveVerdict> => {
  try {
    const response = runtimeEvaluateSchema.safeParse(
      await session.send('Runtime.callFunctionOn', {
        functionDeclaration: SENSITIVE_TARGET_PROBE_FUNCTION,
        objectId,
        returnByValue: true,
      })
    );

    return response.success
      ? classifyProbeValue(response.data.result?.value)
      : { cause: 'the probe call returned no value', kind: 'unknown' };
  } catch {
    return { cause: 'the probe call failed', kind: 'unknown' };
  }
};

const focusedNodeSchema = z.object({
  backendNodeId: z.number().optional(),
  nodeName: z.string().optional(),
});
const focusedDescriptionSchema = z.object({ node: focusedNodeSchema.optional() });

/**
 * Reads and classifies the focused element: `browser_press_key` without a target
 * still types into whatever the page has focused. The object handle comes from
 * the same isolated-world read, so a page mutating its DOM cannot redirect it; a
 * frame the page cannot read is sensitive by itself, and any missing or unknown
 * shape is unknown (sensitive), never plain.
 */
export const classifyFocusedElement = async (session: ProbeSession): Promise<SensitiveVerdict> => {
  try {
    const frameId = await mainFrameId(session);
    const contextId =
      frameId === undefined ? undefined : await frameExecutionContext(session, frameId);

    if (contextId === undefined) {
      return { cause: 'the main frame has no isolated world', kind: 'unknown' };
    }

    const expression = `(() => {
      var doc = document;
      var element = doc.activeElement;
      while (element && (element.tagName === 'IFRAME' || element.tagName === 'FRAME')) {
        var child = null;
        try { child = element.contentDocument; } catch (error) { child = null; }
        if (!child) { return element; }
        doc = child;
        element = doc.activeElement;
      }
      return element;
    })()`;
    const evaluated = evaluatedObjectSchema.safeParse(
      await session.send('Runtime.evaluate', { contextId, expression, returnByValue: false })
    );
    const objectId = evaluated.success ? evaluated.data.result?.objectId : undefined;

    if (objectId === undefined) {
      return { cause: 'the focused element could not be read', kind: 'unknown' };
    }

    const described = focusedDescriptionSchema.safeParse(
      await session.send('DOM.describeNode', { objectId })
    );
    const node = described.success ? described.data.node : undefined;

    if (node?.nodeName === undefined) {
      return { cause: 'the focused node has no name', kind: 'unknown' };
    }

    const nodeName = node.nodeName.toUpperCase();

    if (nodeName === 'IFRAME' || nodeName === 'FRAME') {
      if (node.backendNodeId === undefined) {
        return { cause: 'the focused frame has no owner node', kind: 'unknown' };
      }

      return {
        frameBackendNodeId: node.backendNodeId,
        kind: 'sensitive',
        reason: 'typing into a field inside a frame the page cannot read',
      };
    }

    return await classifyObject(session, objectId);
  } catch {
    return { cause: 'the focused element could not be inspected', kind: 'unknown' };
  }
};

/**
 * Classifies one target element. It resolves and probes inside the frame's
 * isolated world, so page script cannot shadow `type`/`getAttribute`; any
 * failure is unknown (sensitive), never plain.
 */
export const classifyTargetElement = async (
  session: ProbeSession,
  target: string
): Promise<SensitiveVerdict> => {
  try {
    const resolved = await session.resolveTarget(target);

    if (resolved === undefined) {
      return { cause: 'the target did not resolve', kind: 'unknown' };
    }

    if (resolved.kind === 'ambiguous') {
      return { cause: 'the selector matches several elements', kind: 'unknown' };
    }

    const frameId = await targetFrameId(session, resolved);

    if (frameId === undefined) {
      return { cause: 'the target frame could not be read', kind: 'unknown' };
    }

    const executionContextId = await frameExecutionContext(session, frameId);

    if (executionContextId === undefined) {
      return { cause: 'the target frame has no isolated world', kind: 'unknown' };
    }

    const resolvedNode = resolveObjectSchema.safeParse(
      await session.send(
        'DOM.resolveNode',
        resolved.kind === 'ref'
          ? { backendNodeId: resolved.backendNodeId, executionContextId }
          : { executionContextId, nodeId: resolved.nodeId }
      )
    );
    const objectId = resolvedNode.success ? resolvedNode.data.object?.objectId : undefined;

    if (objectId === undefined) {
      return { cause: 'the target could not be resolved to an object', kind: 'unknown' };
    }

    return await classifyObject(session, objectId);
  } catch {
    return { cause: 'the target could not be inspected', kind: 'unknown' };
  }
};

const argumentTextSchema = z.string().min(1);
/** A `browser_fill_form` field as the vendored contract carries it: `target` is the element reference. */
const fillFormFieldsSchema = z.array(
  z.object({
    element: z.string().optional(),
    name: z.string().optional(),
    target: z.string().optional(),
    type: z.string().optional(),
    value: z.string().optional(),
  })
);

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

  for (const key of ['target', 'ref', 'selector', 'startTarget', 'endTarget']) {
    const target = argumentTextSchema.safeParse(args[key]);

    if (target.success) {
      targets.push(target.data);
    }
  }

  const fields = fillFormFieldsSchema.safeParse(args['fields']);

  for (const field of fields.success ? fields.data : []) {
    const target = argumentTextSchema.safeParse(field.target);

    if (target.success) {
      targets.push(target.data);
    }
  }

  return targets;
};

/**
 * The visible boxes of password, one-time-code and payment fields, in the
 * frame's viewport coordinates. The read path translates them into the
 * screenshot's document space and blacks them out, so a credential never
 * reaches an agent as pixels either.
 */
export const SENSITIVE_FIELD_BOXES_PROBE_EXPRESSION = `(() => {
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
  var boxes = [];
  var inputs = document.querySelectorAll('input');
  for (var index = 0; index < inputs.length; index += 1) {
    var input = inputs[index];
    if (kindOf(input) === null) { continue; }
    var rect = input.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { continue; }
    boxes.push({ height: rect.height, width: rect.width, x: rect.left, y: rect.top });
  }
  return JSON.stringify({ boxes: boxes, scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 });
})()`;

const sensitiveBoxesPayloadSchema = z.object({
  boxes: z
    .array(
      // eslint-disable-next-line id-length -- a frame box carries x/y, like the CDP box model it comes from
      z.object({ height: z.number(), width: z.number(), x: z.number(), y: z.number() })
    )
    .optional(),
  scrollX: z.number().optional(),
  scrollY: z.number().optional(),
});

export interface FrameSensitiveBoxes {
  /** Viewport-relative boxes of the frame's sensitive fields. */
  readonly boxes: readonly {
    readonly height: number;
    readonly width: number;
    // eslint-disable-next-line id-length -- a frame box carries x/y, like the CDP box model it comes from
    readonly x: number;
    // eslint-disable-next-line id-length -- see above
    readonly y: number;
  }[];
  readonly scrollX: number;
  readonly scrollY: number;
}

/** The sensitive field boxes of one readable frame; empty when the frame is gone. */
export const readFrameSensitiveBoxes = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<FrameSensitiveBoxes> => {
  try {
    const payload = await readProbePayload({
      expression: SENSITIVE_FIELD_BOXES_PROBE_EXPRESSION,
      frameId,
      schema: sensitiveBoxesPayloadSchema,
      session,
    });

    return {
      boxes: payload?.boxes ?? [],
      scrollX: payload?.scrollX ?? 0,
      scrollY: payload?.scrollY ?? 0,
    };
  } catch {
    return { boxes: [], scrollX: 0, scrollY: 0 };
  }
};
