import { z } from 'zod';
import {
  applyAgentSnapshotLine,
  maskSensitiveValues,
  originPatternMatches,
  toBrowserOrigin,
} from './browser-agent-checks';
import type { AgentSnapshotLine } from './browser-agent-checks';
import { readFrameHiddenText, readFrameSensitiveValues } from './browser-agent-probes';
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserToolRefEntry,
} from './browser-tool-session';
import type { BrowserToolPageSession } from './browser-tool-snapshot';
import type { ScreenshotBox } from './browser-screenshot-masking';
import {
  MAX_BROWSER_TOOL_NAME_LENGTH,
  MAX_BROWSER_TOOL_SNAPSHOT_LINES,
} from './browser-tool-snapshot';

/**
 * Frame scoping for agent callers (SPEC "Frame scoping"): an agent reads the
 * tab's top-level document plus the frames whose origin it holds a `read`
 * grant for. Every other frame's subtree is replaced by one line naming the
 * origin, its screenshot area is blacked out, and its console/network entries
 * are dropped.
 */

export type BrowserAgentFrame = {
  readonly id: string;
  /** Absent on the tab's main frame. */
  readonly parentId?: string;
  /** `scheme://host[:port]`, `file://`, or the raw origin for a non-web frame. */
  readonly origin: string;
  readonly url: string;
};

const framePayloadSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  securityOrigin: z.string().optional(),
  url: z.string(),
  urlFragment: z.string().optional(),
});
const frameTreePayloadSchema = z.object({
  frameTree: z.object({
    childFrames: z.array(z.unknown()).optional(),
    frame: framePayloadSchema,
  }),
});

const frameOriginOf = (frame: z.infer<typeof framePayloadSchema>): string => {
  const url = frame.url === '' ? frame.urlFragment : frame.url;
  const fromUrl = toBrowserOrigin(url);

  if (fromUrl !== undefined) {
    return fromUrl;
  }

  const declared = frame.securityOrigin ?? '';

  return declared === '' || declared === 'null' ? 'opaque:null' : declared;
};

/**
 * Flattens `Page.getFrameTree` into the tab's frames, main frame first. The
 * origin comes from the frame URL when it is a web URL, else the frame's
 * declared `securityOrigin` (an `about:`/`data:`/sandboxed frame is reported
 * as `opaque:null`, which no grant can match).
 */
export const readAgentFrameTree = async (
  session: Pick<BrowserToolPageSession, 'send'>
): Promise<readonly BrowserAgentFrame[]> => {
  const parsed = frameTreePayloadSchema.safeParse(await session.send('Page.getFrameTree'));

  if (!parsed.success) {
    return [];
  }

  const frames: BrowserAgentFrame[] = [];
  const visit = (tree: {
    childFrames?: unknown[] | undefined;
    frame: z.infer<typeof framePayloadSchema>;
  }): void => {
    const children = tree.childFrames ?? [];

    frames.push({
      id: tree.frame.id,
      origin: frameOriginOf(tree.frame),
      ...(tree.frame.parentId === undefined ? {} : { parentId: tree.frame.parentId }),
      url: tree.frame.url,
    });

    for (const child of children) {
      const nested = z
        .object({
          childFrames: z.array(z.unknown()).optional(),
          frame: framePayloadSchema,
        })
        .safeParse(child);

      if (nested.success) {
        visit(nested.data);
      }
    }
  };

  visit(parsed.data.frameTree);

  return frames;
};

/**
 * Enables flattened auto-attach so out-of-process iframes are reachable from
 * the tab's one debugger attachment. Best effort: an older protocol without
 * the method keeps the same-document behaviour instead of failing the call.
 */
export const enableAgentFrameAutoAttach = async (
  session: Pick<BrowserToolPageSession, 'send'>
): Promise<void> => {
  try {
    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
  } catch {
    // A protocol without Target auto-attach still reports same-process frames in Page.getFrameTree.
  }
};

/** The tab's top-level frame, the origin every agent call already had to be granted. */
export const mainFrameOf = (frames: readonly BrowserAgentFrame[]): BrowserAgentFrame | undefined =>
  frames.find(frame => frame.parentId === undefined);

/** Origins (one per frame) whose content the agent may read. */
export const readableFrameIds = (
  frames: readonly BrowserAgentFrame[],
  readableOrigins: readonly string[]
): ReadonlySet<string> => {
  const readable = new Set<string>();

  for (const frame of frames) {
    if (readableOrigins.some(pattern => originPatternMatches(pattern, frame.origin))) {
      readable.add(frame.id);
    }
  }

  return readable;
};

export type WithheldFrame = {
  readonly frameId: string;
  readonly origin: string;
};

/**
 * Frames the agent may not read. The main frame is never withheld: the caller's
 * tab grant is checked before the snapshot runs, and withholding the main
 * document would return an empty page instead of the page it may read.
 */
export const withheldFramesOf = (
  frames: readonly BrowserAgentFrame[],
  readableOrigins: readonly string[]
): readonly WithheldFrame[] =>
  frames
    .filter(
      frame =>
        frame.parentId !== undefined &&
        !readableOrigins.some(pattern => originPatternMatches(pattern, frame.origin))
    )
    .map(frame => ({ frameId: frame.id, origin: frame.origin }));

/**
 * The withheld line a snapshot shows in place of a frame's subtree. Rendered
 * by hand because the shared renderer only emits roles with a name or a ref.
 */
export const withheldFrameLine = (origin: string, depth: number): AgentSnapshotLine => ({
  attributes: `[origin withheld: ${origin}]`,
  depth,
  name: '',
  role: 'iframe',
});

/* ------------------------------------------------------------------ */
/* Accessibility tree splicing                                         */
/* ------------------------------------------------------------------ */

const axValueSchema = z.object({
  type: z.string().optional(),
  value: z.union([z.boolean(), z.number(), z.string()]).optional(),
});
const axNodeSchema = z.object({
  backendDOMNodeId: z.number().optional(),
  childIds: z.array(z.string()).optional(),
  ignored: z.boolean().optional(),
  name: axValueSchema.optional(),
  nodeId: z.string(),
  properties: z.array(z.object({ name: z.string(), value: axValueSchema.optional() })).optional(),
  role: axValueSchema.optional(),
});
const axTreePayloadSchema = z.object({ nodes: z.array(axNodeSchema).optional() });
type AxNode = z.infer<typeof axNodeSchema>;

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

const axText = (value: z.infer<typeof axValueSchema> | undefined): string =>
  value?.value === undefined ? '' : String(value.value);

const REF_PATTERN = /^e(\d+)$/u;

/** Ref → backend node id: refs encode the node id, so a withheld frame's refs can be recognised. */
export const backendNodeIdOfRef = (ref: string): number | undefined => {
  const match = REF_PATTERN.exec(ref);

  return match === null ? undefined : Number(match[1]);
};

export type ScopedSnapshotInput = {
  /** The main frame's own accessibility tree. */
  readonly topNodes: readonly AxNode[];
  /** Owner iframe backend node id → frame id, for every child frame. */
  readonly ownerFrameByBackendNodeId: ReadonlyMap<number, string>;
  /** Accessibility trees of the frames the agent may read, keyed by frame id. */
  readonly readableTrees: ReadonlyMap<string, readonly AxNode[]>;
  /** Withheld frame id → origin. */
  readonly withheld: ReadonlyMap<string, string>;
  readonly depth?: number | undefined;
};

export type ScopedSnapshot = {
  readonly lines: readonly AgentSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly truncated: boolean;
};

/**
 * Renders the main frame's tree with each child frame spliced in: a readable
 * frame's document replaces the iframe node's children, a withheld frame's
 * subtree becomes the single withheld line. Ref allocation matches the shared
 * snapshot renderer (`e<backendNodeId>`), so a ref from a readable frame keeps
 * resolving after this scoped snapshot.
 */
export const buildScopedSnapshot = (input: ScopedSnapshotInput): ScopedSnapshot => {
  const lines: AgentSnapshotLine[] = [];
  const refs: BrowserToolRefEntry[] = [];
  let truncated = false;

  const walk = (nodes: readonly AxNode[], depthBudget: number | undefined, depth: number): void => {
    const byId = new Map<string, AxNode>();

    for (const node of nodes) {
      byId.set(node.nodeId, node);
    }

    const childIds = new Set<string>();

    for (const node of nodes) {
      for (const childId of node.childIds ?? []) {
        childIds.add(childId);
      }
    }

    const visit = (node: AxNode, atDepth: number): void => {
      if (lines.length >= MAX_BROWSER_TOOL_SNAPSHOT_LINES) {
        truncated = true;

        return;
      }

      const role = collapseWhitespace(axText(node.role));
      const name = collapseWhitespace(axText(node.name)).slice(0, MAX_BROWSER_TOOL_NAME_LENGTH);
      const backendNodeId = node.backendDOMNodeId;
      const ownerFrameId =
        backendNodeId === undefined
          ? undefined
          : input.ownerFrameByBackendNodeId.get(backendNodeId);
      const interactive = INTERACTIVE_ROLES.has(role);
      const textRole = TEXT_ROLES.has(role);
      const ignored = node.ignored === true;

      if (!ignored) {
        if (textRole) {
          if (name !== '' && (node.childIds ?? []).length === 0) {
            lines.push({ depth: atDepth, name, role: '', textLeaf: true });
          }
        } else if (role !== '' && (name !== '' || interactive)) {
          const emittedRef =
            interactive && backendNodeId !== undefined ? `e${String(backendNodeId)}` : undefined;

          if (emittedRef !== undefined && backendNodeId !== undefined) {
            refs.push({ backendNodeId, ref: emittedRef });
          }

          lines.push({
            depth: atDepth,
            name,
            role,
            ...(emittedRef === undefined ? {} : { ref: emittedRef }),
          });
        }
      }

      if (depthBudget !== undefined && atDepth >= depthBudget) {
        return;
      }

      if (ownerFrameId !== undefined) {
        const withheldOrigin = input.withheld.get(ownerFrameId);

        if (withheldOrigin !== undefined) {
          lines.push(withheldFrameLine(withheldOrigin, atDepth + 1));
          return;
        }

        const readableTree = input.readableTrees.get(ownerFrameId);

        if (readableTree !== undefined) {
          walk(readableTree, depthBudget, atDepth + 1);
          return;
        }
      }

      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);

        if (child !== undefined) {
          visit(child, atDepth + 1);
        }
      }
    };

    for (const node of nodes) {
      if (!childIds.has(node.nodeId)) {
        visit(node, depth);
      }
    }
  };

  walk(input.topNodes, input.depth, 0);

  return { lines, refs, truncated };
};

/** Reads one frame's accessibility tree; an unavailable frame reads as empty. */
const readFrameAxTree = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<readonly AxNode[]> => {
  try {
    const parsed = axTreePayloadSchema.safeParse(
      await session.send('Accessibility.getFullAXTree', { frameId })
    );

    return parsed.success ? (parsed.data.nodes ?? []) : [];
  } catch {
    // A frame that navigated or detached mid-capture contributes no nodes.
    return [];
  }
};

/**
 * Owner iframe backend node id per child frame (`DOM.getFrameOwner`), the
 * anchor the tree splice and the screenshot mask both key on.
 */
export const readFrameOwners = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameIds: readonly string[]
): Promise<ReadonlyMap<string, number>> => {
  const owners = new Map<string, number>();
  const resultSchema = z.object({
    backendNodeId: z.number().optional(),
    nodeId: z.number().optional(),
  });

  for (const frameId of frameIds) {
    try {
      // eslint-disable-next-line no-await-in-loop -- CDP is a sequential request/response channel per frame
      const parsed = resultSchema.safeParse(await session.send('DOM.getFrameOwner', { frameId }));

      if (parsed.success && parsed.data.backendNodeId !== undefined) {
        owners.set(frameId, parsed.data.backendNodeId);
      }
    } catch {
      // A frame without an owner node (racing navigation) contributes no anchor.
    }
  }

  return owners;
};

export type AgentSnapshotCapture = {
  readonly lines: readonly AgentSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly text: string;
  readonly truncated: boolean;
  readonly withheldFrames: readonly string[];
  /** Frames whose content this capture included, for the probes that follow it. */
  readonly readableFrameIds: readonly string[];
};

export type AgentReadScope = {
  /** Origins the caller holds `read` for; the main frame is included by the tool gate. */
  readonly readableOrigins: readonly string[];
};

const renderLine = (line: AgentSnapshotLine): string => {
  const indent = '  '.repeat(line.depth);

  if (line.textLeaf === true) {
    return `${indent}- text: ${line.name}`;
  }

  const name = line.name === '' ? '' : ` "${line.name.replaceAll('"', '')}"`;
  const ref = line.ref === undefined ? '' : ` [ref=${line.ref}]`;
  const attributes = line.attributes === undefined ? '' : ` ${line.attributes}`;

  return `${indent}- ${line.role}${name}${ref}${attributes}`;
};

/** The line renderer shared with the plain snapshot path; exported so the agent format stays one format. */
export const renderAgentSnapshotLine = renderLine;

/**
 * Captures the agent's scoped snapshot: the tab's frames are read from CDP,
 * frames without a `read` grant are withheld, and every readable frame's tree
 * is spliced into the main frame's tree at its iframe node.
 */
export const captureAgentAriaSnapshot = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  scope: AgentReadScope,
  options: { readonly depth?: number | undefined } = {}
): Promise<AgentSnapshotCapture> => {
  const frames = await readAgentFrameTree(session);

  if (frames.length === 0) {
    return {
      lines: [],
      readableFrameIds: [],
      refs: [],
      text: '(no accessibility nodes)',
      truncated: false,
      withheldFrames: [],
    };
  }

  const main = mainFrameOf(frames);

  if (main === undefined) {
    return {
      lines: [],
      readableFrameIds: [],
      refs: [],
      text: '(no accessibility nodes)',
      truncated: false,
      withheldFrames: [],
    };
  }

  const withheld = withheldFramesOf(frames, scope.readableOrigins);
  const withheldByFrameId = new Map(withheld.map(frame => [frame.frameId, frame.origin]));
  const readableTreeFrames = frames.filter(
    frame => frame.parentId !== undefined && !withheldByFrameId.has(frame.id)
  );

  const topNodes = await readFrameAxTree(session, main.id);
  const readableTrees = new Map<string, readonly AxNode[]>();

  for (const frame of readableTreeFrames) {
    // eslint-disable-next-line no-await-in-loop -- one CDP read per frame, in document order
    readableTrees.set(frame.id, await readFrameAxTree(session, frame.id));
  }

  const owners = await readFrameOwners(
    session,
    frames.filter(frame => frame.parentId !== undefined).map(frame => frame.id)
  );
  const ownerFrameByBackendNodeId = new Map<number, string>();

  for (const [frameId, backendNodeId] of owners) {
    ownerFrameByBackendNodeId.set(backendNodeId, frameId);
  }

  const snapshot = buildScopedSnapshot({
    depth: options.depth,
    ownerFrameByBackendNodeId,
    readableTrees,
    topNodes,
    withheld: withheldByFrameId,
  });
  const body =
    snapshot.lines.length === 0
      ? '(no accessibility nodes)'
      : snapshot.lines.map(renderLine).join('\n');
  const text = snapshot.truncated
    ? `${body}\n... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    : body;

  return {
    lines: snapshot.lines,
    refs: snapshot.refs,
    text,
    truncated: snapshot.truncated,
    readableFrameIds: [main.id, ...readableTreeFrames.map(frame => frame.id)],
    withheldFrames: withheld.map(frame => frame.origin),
  };
};

/* ------------------------------------------------------------------ */
/* Screenshot masking                                                  */
/* ------------------------------------------------------------------ */

const boxModelSchema = z.object({
  model: z
    .object({
      content: z.array(z.number()).optional(),
      height: z.number().optional(),
      width: z.number().optional(),
    })
    .optional(),
});

/** One frame's content box in its parent's viewport coordinates. */
const readFrameContentBox = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  backendNodeId: number
): Promise<ScreenshotBox | undefined> => {
  try {
    const parsed = boxModelSchema.safeParse(
      await session.send('DOM.getBoxModel', { backendNodeId })
    );
    const content = parsed.success ? parsed.data.model?.content : undefined;

    if (content === undefined || content.length < 8) {
      return undefined;
    }

    return {
      height: parsed.success ? (parsed.data.model?.height ?? 0) : 0,
      width: parsed.success ? (parsed.data.model?.width ?? 0) : 0,
      x: content[0] ?? 0,
      y: content[1] ?? 0,
    };
  } catch {
    return undefined;
  }
};

const intersectBox = (outer: ScreenshotBox, inner: ScreenshotBox): ScreenshotBox => {
  const x = Math.max(outer.x, inner.x);
  const y = Math.max(outer.y, inner.y);
  const right = Math.min(outer.x + outer.width, inner.x + inner.width);
  const bottom = Math.min(outer.y + outer.height, inner.y + inner.height);

  return { height: Math.max(0, bottom - y), width: Math.max(0, right - x), x, y };
};

/**
 * The boxes to black out, in the coordinate space the screenshot was captured
 * in. A nested frame's box is clipped by each ancestor frame's box, and
 * `offset` translates document coordinates onto a viewport screenshot.
 */
export const readWithheldFrameBoxes = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frames: readonly BrowserAgentFrame[],
  withheld: readonly WithheldFrame[],
  options: { readonly offset?: { readonly x: number; readonly y: number } } = {}
): Promise<{ readonly boxes: readonly ScreenshotBox[] } | { readonly error: string }> => {
  if (withheld.length === 0) {
    return { boxes: [] };
  }

  const parents = new Map<string, string | undefined>();

  for (const frame of frames) {
    parents.set(frame.id, frame.parentId);
  }

  const owners = await readFrameOwners(
    session,
    frames.filter(frame => frame.parentId !== undefined).map(frame => frame.id)
  );
  const boxes: ScreenshotBox[] = [];
  const offset = options.offset ?? { x: 0, y: 0 };

  for (const frame of withheld) {
    const chain: string[] = [];
    let current: string | undefined = frame.frameId;

    while (current !== undefined && parents.get(current) !== undefined) {
      chain.push(current);
      current = parents.get(current);
    }

    let accumulated: ScreenshotBox | undefined;

    // Outermost frame first: each ancestor clips its own subtree.
    for (const frameId of chain.toReversed()) {
      const ownerBackendNodeId = owners.get(frameId);

      if (ownerBackendNodeId === undefined) {
        return {
          error: `The region of the ${frame.origin} frame could not be measured, so no screenshot was returned.`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- each ancestor box needs the previous one's frame
      const box = await readFrameContentBox(session, ownerBackendNodeId);

      if (box === undefined) {
        return {
          error: `The region of the ${frame.origin} frame could not be measured, so no screenshot was returned.`,
        };
      }

      accumulated = accumulated === undefined ? box : intersectBox(accumulated, box);
    }

    if (accumulated === undefined || accumulated.width <= 0 || accumulated.height <= 0) {
      // A zero-area frame covers no pixels; nothing to mask.
      continue;
    }

    boxes.push({
      height: accumulated.height,
      width: accumulated.width,
      x: accumulated.x + offset.x,
      y: accumulated.y + offset.y,
    });
  }

  return { boxes };
};

/**
 * The image's scale relative to CSS pixels. The screenshot is requested with
 * `scale: 1`, so a scaled image means the device pixel ratio the browser
 * applied; the layout viewport gives the CSS width to divide by.
 */
export const screenshotScale = (input: {
  readonly imageWidth: number | undefined;
  readonly layoutWidth: number | undefined;
}): number => {
  const { imageWidth, layoutWidth } = input;

  if (imageWidth === undefined || layoutWidth === undefined || layoutWidth <= 0) {
    return 1;
  }

  const scale = imageWidth / layoutWidth;

  return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/* ------------------------------------------------------------------ */
/* Console and network filtering                                       */
/* ------------------------------------------------------------------ */

/**
 * Drops console messages a withheld frame produced. A console entry carries
 * its source URL rather than a frame id, so the withheld origins decide; an
 * entry without a URL (the main frame, or an opaque source) stays.
 */
export const filterAgentConsoleMessages = (
  messages: readonly BrowserConsoleMessage[],
  withheld: readonly WithheldFrame[]
): readonly BrowserConsoleMessage[] => {
  if (withheld.length === 0) {
    return messages;
  }

  const withheldOrigins = new Set(withheld.map(frame => frame.origin));

  return messages.filter(message => {
    const origin = toBrowserOrigin(message.url);

    return origin === undefined || !withheldOrigins.has(origin);
  });
};

/** Drops network requests issued by a withheld frame, using the frame id the buffer already records. */
export const filterAgentNetworkRequests = <Request extends Pick<BrowserNetworkRequest, 'frameId'>>(
  requests: readonly Request[],
  withheld: readonly WithheldFrame[]
): readonly Request[] => {
  if (withheld.length === 0) {
    return requests;
  }

  const withheldIds = new Set(withheld.map(frame => frame.frameId));

  return requests.filter(
    request => request.frameId === undefined || !withheldIds.has(request.frameId)
  );
};

export type AgentSnapshotView = AgentSnapshotCapture & {
  /** True when the caller may not read at least one frame, so the bridge can say so. */
  readonly hasWithheldFrames: boolean;
};

/**
 * The snapshot an agent caller sees: frame-scoped, with the page's hidden text
 * dropped and every password/one-time-code/payment value masked. Registering
 * the refs here keeps a ref from a readable frame resolvable by the next call.
 */
export const captureAgentSnapshotView = async (
  session: Pick<BrowserToolPageSession, 'send' | 'registerRefs'>,
  scope: AgentReadScope,
  options: {
    readonly depth?: number | undefined;
    readonly mergeRefs?: boolean;
  } = {}
): Promise<AgentSnapshotView> => {
  const capture = await captureAgentAriaSnapshot(session, scope, {
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  });
  const hiddenText = new Set<string>();
  const sensitiveValues = new Set<string>();

  for (const frameId of capture.readableFrameIds) {
    // eslint-disable-next-line no-await-in-loop -- one probe pair per frame; a frame probe is two CDP round trips
    const hidden = await readFrameHiddenText(session, frameId);

    for (const text of hidden) {
      hiddenText.add(text);
    }

    // eslint-disable-next-line no-await-in-loop -- see above: probes run per frame
    const values = await readFrameSensitiveValues(session, frameId);

    for (const value of values) {
      sensitiveValues.add(value);
    }
  }

  const lines: AgentSnapshotLine[] = [];

  for (const line of capture.lines) {
    const kept = applyAgentSnapshotLine(line, { hiddenText, sensitiveValues });

    if (kept !== undefined) {
      lines.push(kept);
    }
  }

  session.registerRefs(capture.refs, { merge: options.mergeRefs === true });

  const body = lines.length === 0 ? '(no accessibility nodes)' : lines.map(renderLine).join('\n');
  const text = capture.truncated
    ? `${body}\n... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    : body;

  return {
    lines,
    readableFrameIds: capture.readableFrameIds,
    refs: capture.refs,
    text: maskSensitiveValues(text, [...sensitiveValues]),
    truncated: capture.truncated,
    withheldFrames: capture.withheldFrames,
    hasWithheldFrames: capture.withheldFrames.length > 0,
  };
};

const layoutMetricsSchema = z.object({
  cssLayoutViewport: z.object({ clientWidth: z.number().optional() }).optional(),
  cssVisualViewport: z
    .object({ pageX: z.number().optional(), pageY: z.number().optional() })
    .optional(),
  layoutViewport: z.object({ clientWidth: z.number().optional() }).optional(),
});

export type AgentScreenshotGeometry = {
  /** Device pixels per CSS pixel, used to scale frame boxes onto the image. */
  readonly scale: number;
  /** Document → viewport translation for a non-full-page capture. */
  readonly offset: { readonly x: number; readonly y: number };
};

/**
 * The screenshot's pixel geometry: the device scale factor (the layout
 * viewport is in device pixels, the CSS one in CSS pixels) and the scroll
 * offset a viewport capture is translated by.
 */
export const readAgentScreenshotGeometry = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  options: { readonly fullPage: boolean }
): Promise<AgentScreenshotGeometry> => {
  const parsed = layoutMetricsSchema.safeParse(await session.send('Page.getLayoutMetrics'));
  const layoutWidth = parsed.success ? parsed.data.layoutViewport?.clientWidth : undefined;
  const cssWidth = parsed.success ? parsed.data.cssLayoutViewport?.clientWidth : undefined;
  const visual = parsed.success ? parsed.data.cssVisualViewport : undefined;
  const scale =
    layoutWidth !== undefined && cssWidth !== undefined && cssWidth > 0 && layoutWidth > 0
      ? layoutWidth / cssWidth
      : 1;

  return {
    offset:
      options.fullPage || visual === undefined
        ? { x: 0, y: 0 }
        : { x: -(visual.pageX ?? 0), y: -(visual.pageY ?? 0) },
    scale,
  };
};
