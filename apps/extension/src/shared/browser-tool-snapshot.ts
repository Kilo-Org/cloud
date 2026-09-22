/* eslint-disable max-lines -- The aria snapshot substrate: CDP Accessibility decoding, ref allocation, box lookup and the injected DOM fallback are one cohesive unit. */
import { z } from 'zod';
import { TAB_NOT_INSPECTABLE_ERROR } from './tab-debugger';
import type { BrowserToolRefEntry, BrowserToolSession } from './browser-tool-session';

/**
 * The subset of `BrowserToolSession` the read-only tools drive. Narrowing the
 * dependency keeps this module testable with a fake session and independent of
 * the session's other backends.
 */
export type BrowserToolPageSession = Pick<
  BrowserToolSession,
  | 'attach'
  | 'consoleMessages'
  | 'networkRequestsSinceLoad'
  | 'registerRefs'
  | 'resolveTarget'
  | 'send'
>;

/** Lines of aria snapshot text one result returns. The cap keeps one page from flooding the model's context. */
export const MAX_BROWSER_TOOL_SNAPSHOT_LINES = 2000;
/** Characters of a single browser tool result. Shared with the read-action formatters. */
export const MAX_BROWSER_TOOL_RESULT_LENGTH = 60_000;
/** Characters kept per aria name; a pathological attribute cannot dominate a line. */
export const MAX_BROWSER_TOOL_NAME_LENGTH = 300;
/** How many aria snapshot lines `browser_find` shows after a match. */
export const MAX_BROWSER_TOOL_FIND_CONTEXT_LINES = 3;

/**
 * An extension page has no workspace root, so a Playwright `filename` argument
 * cannot be honoured. The result is returned inline instead; this note says so
 * in one line.
 */
export const describeUnsupportedFilename = (filename: string): string =>
  `The extension has no workspace root, so "${filename}" could not be written; the result is returned inline instead.`;

/**
 * Chrome refuses the debugger on browser-internal targets with its own
 * wording, and the extension's own inspectability check reports the same
 * condition with a sentinel; a tab that is gone also has no debugger target.
 * Any of these means the tool cannot read the page.
 */
const NON_INSPECTABLE_ERROR_FRAGMENTS: readonly string[] = [
  TAB_NOT_INSPECTABLE_ERROR,
  'No tab with id',
  'Cannot access a chrome:// URL',
  'Cannot access a chrome-extension:// URL',
  'Cannot access contents of the page',
];

const NOT_INSPECTABLE_HINT =
  'The current tab cannot be inspected: browser-internal pages such as chrome:// and the extension\u2019s own pages have no debugger target. Switch to a normal web page and try again.';

/**
 * Translate an uninspectable/gone tab into an actionable message; every other
 * failure keeps its own text so a protocol error is not disguised as a
 * page-access problem.
 */
export const toBrowserToolErrorMessage = (message: string): string =>
  NON_INSPECTABLE_ERROR_FRAGMENTS.some(fragment => message.includes(fragment))
    ? NOT_INSPECTABLE_HINT
    : message;

/** Turn a caught value into the message a tool result carries. */
export const caughtMessage = (caught: Error | string): string =>
  toBrowserToolErrorMessage(caught instanceof Error ? caught.message : caught);

/** Bounds a result so a chatty page cannot return an unbounded payload. */
export const boundBrowserToolText = (text: string): string =>
  text.length > MAX_BROWSER_TOOL_RESULT_LENGTH
    ? `${text.slice(0, MAX_BROWSER_TOOL_RESULT_LENGTH)}\n... (result truncated at ${String(MAX_BROWSER_TOOL_RESULT_LENGTH)} characters)`
    : text;

/**
 * The raw `Accessibility.getFullAXTree` node shape this module reads. CDP adds
 * many more fields; only the fields the snapshot needs are declared, and the
 * response is decoded with zod rather than cast.
 */
const axValueSchema = z.object({
  type: z.string().optional(),
  value: z.union([z.boolean(), z.number(), z.string()]).optional(),
});
const axPropertySchema = z.object({ name: z.string(), value: axValueSchema.optional() });
const axNodeSchema = z.object({
  backendDOMNodeId: z.number().optional(),
  childIds: z.array(z.string()).optional(),
  ignored: z.boolean().optional(),
  name: axValueSchema.optional(),
  nodeId: z.string(),
  properties: z.array(axPropertySchema).optional(),
  role: axValueSchema.optional(),
});
const fullAxTreeResultSchema = z.object({ nodes: z.array(axNodeSchema).optional() });
const domDescribeNodeResultSchema = z.object({
  node: z.object({ backendDOMNodeId: z.number().optional() }).optional(),
});
const domBoxModelResultSchema = z.object({
  model: z
    .object({
      content: z.array(z.number()).optional(),
      height: z.number().optional(),
      width: z.number().optional(),
    })
    .optional(),
});
const runtimeEvaluateResultSchema = z.object({
  result: z.object({ value: z.unknown().optional() }).optional(),
});
/** Hoisted so a result value is decoded without building a schema inside the read path. */
const runtimeValueStringSchema = z.string();
const runtimeValueNumberSchema = z.number();
const domSnapshotEnvelopeSchema = z.object({
  lines: z.array(
    z.object({
      attributes: z.string().optional(),
      box: z.string().optional(),
      depth: z.number(),
      name: z.string(),
      ref: z.string().optional(),
      role: z.string(),
      textLeaf: z.boolean().optional(),
    })
  ),
  refs: z.array(
    z.object({
      backendNodeId: z.number().optional(),
      ref: z.string(),
      selector: z.string().optional(),
    })
  ),
  truncated: z.boolean().optional(),
});

export type BrowserAriaNode = z.infer<typeof axNodeSchema>;

/** One rendered `- role "name" [ref=eN]` line, or a `- text: ...` leaf. */
export interface BrowserAriaSnapshotLine {
  readonly attributes?: string;
  readonly box?: string;
  readonly depth: number;
  readonly name: string;
  readonly ref?: string;
  readonly role: string;
  readonly textLeaf?: boolean;
}

export interface BrowserAriaSnapshot {
  readonly lines: readonly BrowserAriaSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly truncated: boolean;
}

export interface BrowserSnapshotArguments {
  readonly boxes?: boolean | undefined;
  readonly depth?: number | undefined;
  readonly filename?: string | undefined;
  readonly target?: string | undefined;
}

export interface BrowserAriaSnapshotCapture {
  readonly lines: readonly BrowserAriaSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Interactive roles carry `[ref=eN]`, matching the scripting backend's
 * `__buildAria` so both backends present one snapshot format.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const TEXT_ROLES: ReadonlySet<string> = new Set([
  'InlineTextBox',
  'LineBreak',
  'StaticText',
  'text',
]);

const collapseWhitespace = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

const normalizeAriaName = (value: string): string =>
  collapseWhitespace(value).slice(0, MAX_BROWSER_TOOL_NAME_LENGTH);

/** `[ref=eN]` targets are encoded from the backend node id, so a ref survives every snapshot of the same document. */
export const toAriaRef = (backendNodeId: number): string => `e${String(backendNodeId)}`;

const axValueText = (value: z.infer<typeof axValueSchema> | undefined): string =>
  value?.value === undefined ? '' : String(value.value);

const AX_LEVEL = z.number();
const AX_TRUTHY = z.union([z.literal(true), z.literal('mixed'), z.literal('true')]);

/** CDP accessibility properties rendered the way the scripting backend renders its `[level=..]`/`[disabled]` set. */
const formatAxAttributes = (node: BrowserAriaNode): string => {
  const properties = new Map<string, z.infer<typeof axValueSchema> | undefined>();

  for (const property of node.properties ?? []) {
    properties.set(property.name, property.value);
  }

  const parts: string[] = [];
  const level = AX_LEVEL.safeParse(properties.get('level')?.value);

  if (level.success) {
    parts.push(`[level=${String(level.data)}]`);
  }

  for (const [propertyName, renderedName] of [
    ['disabled', 'disabled'],
    ['checked', 'checked'],
    ['expanded', 'expanded'],
    ['pressed', 'pressed'],
    ['selected', 'selected'],
    ['focused', 'active'],
  ] as const) {
    if (AX_TRUTHY.safeParse(properties.get(propertyName)?.value).success) {
      parts.push(`[${renderedName}]`);
    }
  }

  return parts.join('');
};

const renderSnapshotLine = (line: BrowserAriaSnapshotLine): string => {
  const indent = '  '.repeat(line.depth);

  if (line.textLeaf === true) {
    return `${indent}- text: ${line.name}`;
  }

  const name = line.name === '' ? '' : ` "${line.name.replaceAll('"', '')}"`;
  const ref = line.ref === undefined ? '' : ` [ref=${line.ref}]`;
  const attributes = line.attributes ?? '';
  const box = line.box === undefined ? '' : ` [${line.box}]`;

  return `${indent}- ${line.role}${name}${ref}${attributes}${box}`;
};

export const renderBrowserAriaSnapshotLine = renderSnapshotLine;

export const renderBrowserAriaSnapshot = (snapshot: BrowserAriaSnapshot): string =>
  snapshot.lines.map(line => renderSnapshotLine(line)).join('\n');

/**
 * Render an `Accessibility.getFullAXTree` payload as a Playwright-shaped aria
 * snapshot. Ignored wrapper nodes are flattened (their children render at the
 * wrapper's depth); interactive nodes get `[ref=eN]` where N is the backend
 * node id, so a ref resolves to the same element on every snapshot until
 * navigation clears the session registry.
 */
export const buildBrowserAriaSnapshot = (
  nodes: readonly BrowserAriaNode[],
  options: {
    readonly boxForBackendNodeId?: (backendNodeId: number) => string | undefined;
    readonly depth?: number;
    readonly rootBackendNodeId?: number;
  } = {}
): BrowserAriaSnapshot => {
  const byId = new Map<string, BrowserAriaNode>();

  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }

  const childIds = new Set<string>();

  for (const node of nodes) {
    for (const childId of node.childIds ?? []) {
      childIds.add(childId);
    }
  }

  const rootNode =
    options.rootBackendNodeId === undefined
      ? undefined
      : nodes.find(node => node.backendDOMNodeId === options.rootBackendNodeId);

  /**
   * A target the tree does not contain (a hidden element a `DOM.querySelector`
   * still matched) must render nothing, not the whole tree: an empty root list
   * lets the caller raise its "no node for target" error, while the fallback
   * belongs to the no-target case only.
   */
  const rootsFor = (): BrowserAriaNode[] => {
    if (options.rootBackendNodeId === undefined) {
      return nodes.filter(node => !childIds.has(node.nodeId));
    }

    return rootNode === undefined ? [] : [rootNode];
  };
  const roots = rootsFor();

  const lines: BrowserAriaSnapshotLine[] = [];
  const refs: BrowserToolRefEntry[] = [];
  let truncated = false;

  const visit = (node: BrowserAriaNode, depth: number): void => {
    if (lines.length >= MAX_BROWSER_TOOL_SNAPSHOT_LINES) {
      truncated = true;

      return;
    }

    const role = collapseWhitespace(axValueText(node.role));
    const name = normalizeAriaName(axValueText(node.name));
    const backendNodeId = node.backendDOMNodeId;
    const interactive = INTERACTIVE_ROLES.has(role);
    const ref = interactive && backendNodeId !== undefined ? toAriaRef(backendNodeId) : undefined;

    if (ref !== undefined && backendNodeId !== undefined) {
      refs.push({ backendNodeId, ref });
    }

    const children = (node.childIds ?? []).flatMap(childId => {
      const child = byId.get(childId);

      return child === undefined ? [] : [child];
    });
    const ignored = node.ignored === true;
    const textRole = TEXT_ROLES.has(role);

    if (!ignored) {
      if (textRole) {
        if (name !== '' && children.length === 0) {
          lines.push({ depth, name, role: '', textLeaf: true });
        }
      } else if (role !== '' && (name !== '' || interactive)) {
        const box =
          ref !== undefined && backendNodeId !== undefined
            ? options.boxForBackendNodeId?.(backendNodeId)
            : undefined;
        lines.push({
          attributes: formatAxAttributes(node),
          depth,
          name,
          role,
          ...(box === undefined ? {} : { box }),
          ...(ref === undefined ? {} : { ref }),
        });
      }
    }

    if (options.depth !== undefined && depth >= options.depth) {
      return;
    }

    for (const child of children) {
      visit(child, ignored ? depth : depth + 1);
    }
  };

  for (const root of roots) {
    visit(root, 0);
  }

  return { lines, refs, truncated };
};

/**
 * `browser_snapshot` boxes are viewport-relative CSS pixels, matching
 * `Element.getBoundingClientRect`. `DOM.getBoxModel` already reports
 * viewport-relative coordinates, so no scroll conversion is applied.
 */
const readBoxes = async (
  session: BrowserToolPageSession,
  refs: readonly BrowserToolRefEntry[]
): Promise<Map<number, string>> => {
  const boxes = new Map<number, string>();
  const backendNodeIds = refs.flatMap(entry =>
    entry.backendNodeId === undefined ? [] : [entry.backendNodeId]
  );

  if (backendNodeIds.length === 0) {
    return boxes;
  }

  const measured = await Promise.all(
    backendNodeIds.map(async backendNodeId => {
      try {
        const parsed = domBoxModelResultSchema.safeParse(
          await session.send('DOM.getBoxModel', { backendNodeId })
        );
        const model = parsed.success ? parsed.data.model : undefined;
        const content = model?.content;

        if (model === undefined || content === undefined || content.length < 2) {
          return null;
        }

        return [
          backendNodeId,
          `box=${String(Math.round(content[0] ?? 0))},${String(Math.round(content[1] ?? 0))},${String(Math.round(model.width ?? 0))},${String(Math.round(model.height ?? 0))}`,
        ] as const;
      } catch {
        // A node without a layout box (display:none, detached) simply has no box in the snapshot.
        return null;
      }
    })
  );

  for (const entry of measured) {
    if (entry !== null) {
      boxes.set(entry[0], entry[1]);
    }
  }

  return boxes;
};

/**
 * The page-injected DOM snapshot used when the CDP Accessibility domain is
 * unavailable. It follows the injected page-helper contract used by
 * `agent-workflow-runner.ts`: a self-contained function string evaluated in the
 * page, returning JSON. Refs are selector-backed here because no backend node
 * ids exist without CDP.
 */
const DOM_ARIA_SNAPSHOT_FUNCTION = `function (options) {
  var maxLines = options.maxLines;
  var maxDepth = typeof options.depth === 'number' ? options.depth : null;
  var withBoxes = options.boxes === true;
  var rootSelector = typeof options.rootSelector === 'string' ? options.rootSelector : null;
  var INTERACTIVE_ROLES = ['button','checkbox','combobox','link','listbox','menuitem','option','radio','searchbox','slider','spinbutton','switch','tab','textbox','treeitem'];
  var ROLE_BY_TAG = {
    a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', img: 'img', li: 'listitem', ol: 'list', option: 'option',
    p: 'paragraph', select: 'combobox', table: 'table', td: 'cell', textarea: 'textbox',
    th: 'columnheader', tr: 'row', ul: 'list'
  };
  var INPUT_ROLES = { button: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', reset: 'button', search: 'searchbox', submit: 'button' };
  var lines = [];
  var refs = [];
  var counter = 0;
  var truncated = false;
  var collapse = function (value) { return String(value == null ? '' : value).replace(/\\s+/gu, ' ').trim(); };
  var roleOf = function (element) {
    var explicit = collapse(element.getAttribute('role'));
    if (explicit !== '') { return explicit; }
    var tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      return INPUT_ROLES[(element.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    }
    return ROLE_BY_TAG[tag] || '';
  };
  var nameOf = function (element) {
    var candidates = [
      element.getAttribute('aria-label'), element.getAttribute('alt'), element.getAttribute('placeholder'),
      element.value, element.textContent
    ];
    for (var index = 0; index < candidates.length; index++) {
      var candidate = collapse(candidates[index]);
      if (candidate !== '') { return candidate.slice(0, options.maxNameLength); }
    }
    return '';
  };
  var selectorOf = function (element) {
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && parts.length < 10) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; });
        if (siblings.length > 1) { part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  var attributesOf = function (element) {
    var parts = [];
    var tag = element.tagName.toLowerCase();
    var level = element.getAttribute('aria-level');
    if (level !== null && level !== '') { parts.push('[level=' + level + ']'); }
    else if (/^h[1-6]$/u.test(tag)) { parts.push('[level=' + tag.charAt(1) + ']'); }
    if (element.getAttribute('aria-disabled') === 'true' || element.disabled === true) { parts.push('[disabled]'); }
    if (element.checked === true) { parts.push('[checked]'); }
    if (element.getAttribute('aria-expanded') === 'true') { parts.push('[expanded]'); }
    if (element.getAttribute('aria-pressed') === 'true') { parts.push('[pressed]'); }
    if (element.getAttribute('aria-selected') === 'true') { parts.push('[selected]'); }
    if (document.activeElement === element) { parts.push('[active]'); }
    return parts.join('');
  };
  var visible = function (element) {
    var style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  var walk = function (element, depth) {
    if (lines.length >= maxLines) { truncated = true; return; }
    if (maxDepth !== null && depth > maxDepth) { return; }
    if (!visible(element)) { return; }
    var role = roleOf(element);
    var name = nameOf(element);
    var interactive = INTERACTIVE_ROLES.indexOf(role) !== -1;
    var ref;
    if (interactive) {
      counter += 1;
      ref = 'e' + counter;
      refs.push({ ref: ref, selector: selectorOf(element) });
    }
    var children = Array.prototype.filter.call(element.children, visible);
    if (role === '' && name !== '' && children.length === 0) {
      lines.push({ depth: depth, name: name, role: '', textLeaf: true });
    } else if (role !== '' && (name !== '' || interactive)) {
      var line = { attributes: attributesOf(element), depth: depth, name: name, role: role };
      if (ref !== undefined) { line.ref = ref; }
      if (withBoxes) {
        var rect = element.getBoundingClientRect();
        line.box = 'box=' + Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + ',' + Math.round(rect.height);
      }
      lines.push(line);
    }
    for (var index = 0; index < element.children.length; index++) { walk(element.children[index], depth + 1); }
  };
  var root = rootSelector === null ? (document.body || document.documentElement) : document.querySelector(rootSelector);
  if (root) { walk(root, 0); }
  return JSON.stringify({ lines: lines, refs: refs, truncated: truncated });
}`;

const buildDomSnapshotExpression = (options: {
  readonly boxes?: boolean;
  readonly depth?: number;
  readonly maxLines: number;
  readonly maxNameLength: number;
  readonly rootSelector?: string;
}): string => `(${DOM_ARIA_SNAPSHOT_FUNCTION})(${JSON.stringify(options)})`;

const readRuntimeEvaluateValue = async (
  session: BrowserToolPageSession,
  expression: string
): Promise<z.infer<typeof runtimeEvaluateResultSchema>['result']> => {
  const parsed = runtimeEvaluateResultSchema.safeParse(
    await session.send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })
  );

  return parsed.success ? parsed.data.result : undefined;
};

const captureDomAriaSnapshot = async (
  session: BrowserToolPageSession,
  options: {
    readonly boxes?: boolean;
    readonly depth?: number;
    readonly rootSelector?: string;
  }
): Promise<BrowserAriaSnapshot> => {
  const result = await readRuntimeEvaluateValue(
    session,
    buildDomSnapshotExpression({
      maxLines: MAX_BROWSER_TOOL_SNAPSHOT_LINES,
      maxNameLength: MAX_BROWSER_TOOL_NAME_LENGTH,
      ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.rootSelector === undefined ? {} : { rootSelector: options.rootSelector }),
    })
  );
  const asString = runtimeValueStringSchema.safeParse(result?.value);

  if (!asString.success) {
    throw new Error('The page did not return a DOM snapshot.');
  }

  const parsed = domSnapshotEnvelopeSchema.safeParse(JSON.parse(asString.data));

  if (!parsed.success) {
    throw new Error('The page returned a malformed DOM snapshot.');
  }

  const lines: BrowserAriaSnapshotLine[] = parsed.data.lines.map(line => ({
    depth: line.depth,
    name: line.name,
    role: line.role,
    ...(line.attributes === undefined ? {} : { attributes: line.attributes }),
    ...(line.box === undefined ? {} : { box: line.box }),
    ...(line.ref === undefined ? {} : { ref: line.ref }),
    ...(line.textLeaf === undefined ? {} : { textLeaf: line.textLeaf }),
  }));
  const refs: BrowserToolRefEntry[] = parsed.data.refs.map(ref => ({
    ref: ref.ref,
    ...(ref.backendNodeId === undefined ? {} : { backendNodeId: ref.backendNodeId }),
    ...(ref.selector === undefined ? {} : { selector: ref.selector }),
  }));

  return { lines, refs, truncated: parsed.data.truncated === true };
};

const resolveTargetBackendNodeId = async (
  session: BrowserToolPageSession,
  target: string
): Promise<number> => {
  const resolved = await session.resolveTarget(target);

  if (resolved === undefined) {
    throw new Error(
      `No element matched target "${target}". Take a fresh snapshot and use a ref or selector from it.`
    );
  }

  if (resolved.kind === 'ref') {
    return resolved.backendNodeId;
  }

  const parsed = domDescribeNodeResultSchema.safeParse(
    await session.send('DOM.describeNode', { nodeId: resolved.nodeId })
  );
  const backendNodeId = parsed.success ? parsed.data.node?.backendDOMNodeId : undefined;

  if (backendNodeId === undefined) {
    throw new Error(
      `The element for target "${target}" is no longer in the page. Take a fresh snapshot.`
    );
  }

  return backendNodeId;
};

/** The fallback walker keys off a selector, so a target must resolve to one. */
const resolveTargetSelector = async (
  session: BrowserToolPageSession,
  target: string
): Promise<string> => {
  const resolved = await session.resolveTarget(target);

  if (resolved !== undefined && resolved.kind === 'selector') {
    return resolved.selector;
  }

  throw new Error(
    `Target "${target}" cannot be resolved without accessibility support. Take a fresh snapshot or pass a CSS selector.`
  );
};

/**
 * The `Accessibility.getFullAXTree` path. Returns undefined when the protocol
 * does not expose the Accessibility domain (older targets), so the caller can
 * fall back to the injected DOM walker. A target that has no node in the tree
 * is a real error, not a fallback.
 */
const captureAxTreeSnapshot = async (
  session: BrowserToolPageSession,
  options: BrowserSnapshotArguments,
  rootBackendNodeId: number | undefined
): Promise<BrowserAriaSnapshot | undefined> => {
  try {
    const parsed = fullAxTreeResultSchema.safeParse(
      await session.send('Accessibility.getFullAXTree')
    );
    const nodes = parsed.success ? (parsed.data.nodes ?? []) : [];

    if (nodes.length === 0) {
      return undefined;
    }

    const treeOptions = {
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(rootBackendNodeId === undefined ? {} : { rootBackendNodeId }),
    };
    const initial = buildBrowserAriaSnapshot(nodes, treeOptions);

    if (rootBackendNodeId !== undefined && initial.lines.length === 0) {
      throw new Error(
        `The accessibility tree has no node for target "${String(options.target)}". Take a fresh snapshot.`
      );
    }

    if (options.boxes !== true) {
      return initial;
    }

    const boxes = await readBoxes(session, initial.refs);

    return buildBrowserAriaSnapshot(nodes, {
      ...treeOptions,
      boxForBackendNodeId: backendNodeId => boxes.get(backendNodeId),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('The accessibility tree has no node')) {
      throw error;
    }
    // The protocol may not expose the Accessibility domain (older targets); fall through to the injected DOM walker.
    return undefined;
  }
};

/**
 * Build the current aria snapshot, register every emitted ref so the
 * click/type/hover/drag/select_option/evaluate tools resolve the same target,
 * and return the snapshot text. Uses `Accessibility.getFullAXTree` and falls
 * back to the injected DOM walker when CDP accessibility is unavailable.
 */
export const captureBrowserAriaSnapshot = async (
  session: BrowserToolPageSession,
  options: BrowserSnapshotArguments
): Promise<BrowserAriaSnapshotCapture> => {
  const rootBackendNodeId =
    options.target === undefined || options.target === ''
      ? undefined
      : await resolveTargetBackendNodeId(session, options.target);
  const snapshot = await captureAxTreeSnapshot(session, options, rootBackendNodeId);

  const resolvedSnapshot =
    snapshot ??
    (await captureDomAriaSnapshot(session, {
      ...(options.boxes === undefined ? {} : { boxes: options.boxes }),
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.target === undefined || options.target === ''
        ? {}
        : { rootSelector: await resolveTargetSelector(session, options.target) }),
    }));

  const targeted = options.target !== undefined && options.target !== '';
  session.registerRefs(resolvedSnapshot.refs, { merge: targeted });

  const body =
    resolvedSnapshot.lines.length === 0
      ? '(no accessibility nodes)'
      : renderBrowserAriaSnapshot(resolvedSnapshot);
  const text = resolvedSnapshot.truncated
    ? `${body}\n... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    : body;

  return {
    lines: resolvedSnapshot.lines,
    refs: resolvedSnapshot.refs,
    text: boundBrowserToolText(text),
    truncated: resolvedSnapshot.truncated,
  };
};

/** Reads the tab's visible text; shared by `browser_wait_for`. */
export const readPageText = async (session: BrowserToolPageSession): Promise<string> => {
  const text = await readPageString(
    session,
    '(document.body && document.body.innerText) || (document.body && document.body.textContent) || ""'
  );

  return text ?? '';
};

/** Evaluates an expression in the page and returns its value when it is a string. */
export const readPageString = async (
  session: BrowserToolPageSession,
  expression: string
): Promise<string | undefined> => {
  const result = await readRuntimeEvaluateValue(session, expression);
  const asString = runtimeValueStringSchema.safeParse(result?.value);

  return asString.success ? asString.data : undefined;
};

/**
 * The page's navigation start in milliseconds since the epoch
 * (`performance.timeOrigin`), used to scope console messages to the current
 * navigation. Undefined when the page cannot report it.
 */
export const readPageTimeOrigin = async (
  session: BrowserToolPageSession
): Promise<number | undefined> => {
  const result = await readRuntimeEvaluateValue(session, 'performance.timeOrigin');
  const asNumber = runtimeValueNumberSchema.safeParse(result?.value);

  return asNumber.success ? asNumber.data : undefined;
};
