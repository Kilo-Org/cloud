/* eslint-disable max-lines -- Frame scoping, snapshot splicing and the screenshot mask geometry are one unit: they all key on the same frame tree and owner nodes. */
/* eslint-disable id-length -- frame boxes and their offsets carry x/y, the names the CDP box model and the screenshot clip use. */
import { z } from 'zod';
import {
  applyAgentSnapshotLine,
  maskSensitiveValues,
  originPatternMatches,
  toBrowserOrigin,
} from './browser-agent-checks';
import type { AgentSnapshotLine } from './browser-agent-checks';
import {
  readFrameHiddenText,
  readFrameSensitiveBoxes,
  readFrameSensitiveValues,
} from './browser-agent-probes';
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserToolChildFrame,
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

export interface BrowserAgentFrame {
  readonly id: string;
  /** Absent on the tab's main frame. */
  readonly parentId?: string;
  /** `scheme://host[:port]`, `file://`, or the raw origin for a non-web frame. */
  readonly origin: string;
  readonly url: string;
}

const framePayloadSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  securityOrigin: z.string().optional(),
  url: z.string(),
  urlFragment: z.string().optional(),
});
const frameTreeChildSchema = z.object({
  childFrames: z.array(z.unknown()).optional(),
  frame: framePayloadSchema,
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
const readSameProcessFrames = async (
  session: Pick<BrowserToolPageSession, 'send'>
): Promise<readonly BrowserAgentFrame[] | undefined> => {
  let payload: Record<string, unknown> | undefined = undefined;

  try {
    payload = await session.send('Page.getFrameTree');
  } catch {
    // The tab may be gone, or a protocol implementation may refuse the call; the caller then has no same-process frame list.
    return undefined;
  }

  const parsed = frameTreePayloadSchema.safeParse(payload);

  if (!parsed.success) {
    return undefined;
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
      const nested = frameTreeChildSchema.safeParse(child);

      if (nested.success) {
        visit(nested.data);
      }
    }
  };

  visit(parsed.data.frameTree);

  return frames;
};

/**
 * The tab's frame inventory. Chrome keeps out-of-process iframes out of
 * `Page.getFrameTree`, so the tab's auto-attached child frames — which carry
 * their URL as well as the child session that can read them — are appended as
 * children of the main frame and re-parented onto the document that really
 * holds their owner element.
 */
export interface AgentFrameInventory {
  /** Main frame first; every frame the tab knows about, OOPIFs included. */
  readonly frames: readonly BrowserAgentFrame[];
  /** Flattened child session per out-of-process iframe frame id. */
  readonly childSessions: ReadonlyMap<string, string>;
  /**
   * False when the browser reported no same-process frame tree at all. A
   * snapshot can still render the main frame's own tree then, but no capture
   * can prove which regions belong to frames it never saw — so a screenshot
   * must fail closed instead of shipping pixels.
   */
  readonly complete: boolean;
}

export type AgentFrameSession = Pick<BrowserToolPageSession, 'send'> & {
  readonly childFrames?: () => ReadonlyMap<string, { readonly url: string; readonly sessionId: string }>;
};

/**
 * An out-of-process iframe's own frame tree names the frame that owns it, which
 * is how a nested OOPIF is attached to its real parent instead of the main
 * frame. `DOM.describeNode` cannot answer this: on an iframe element its
 * `frameId` is the hosted frame, not the document holding the element.
 */
const readChildFrameParent = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  sessionId: string
): Promise<string | undefined> => {
  try {
    const parsed = frameTreePayloadSchema.safeParse(
      await session.send('Page.getFrameTree', undefined, sessionId)
    );

    return parsed.success ? parsed.data.frameTree.frame.parentId : undefined;
  } catch {
    return undefined;
  }
};

export const readAgentFrames = async (session: AgentFrameSession): Promise<AgentFrameInventory> => {
  const sameProcess = await readSameProcessFrames(session);
  const frames: BrowserAgentFrame[] = [...(sameProcess ?? [])];
  const main = mainFrameOf(frames);
  const childSessions = new Map<string, string>();

  if (main === undefined) {
    // Without a main frame there is no anchor for an OOPIF and no way to tell the tab's own origin: report no frames so every caller withholds.
    return { childSessions, complete: false, frames };
  }

  const attached: ReadonlyMap<string, BrowserToolChildFrame> =
    session.childFrames?.() ?? new Map();

  for (const [frameId, child] of attached) {
    if (!frames.some(frame => frame.id === frameId)) {
      childSessions.set(frameId, child.sessionId);
      // eslint-disable-next-line no-await-in-loop -- one child-session read per attached frame
      const parentFrameId = await readChildFrameParent(session, child.sessionId);

      frames.push({
        id: frameId,
        // A URL no origin can be read from is opaque, so no grant matches it.
        origin: toBrowserOrigin(child.url) ?? 'opaque:null',
        parentId: parentFrameId ?? main.id,
        url: child.url,
      });
    }
  }

  return { childSessions, complete: sameProcess !== undefined, frames };
};

/**
 * The frames a snapshot, mask or grant check works from. Every caller that
 * only needs the frame list uses this; the child sessions stay internal to the
 * snapshot that splices their trees.
 */
export const readAgentFrameTree = async (
  session: AgentFrameSession
): Promise<readonly BrowserAgentFrame[]> => {
  const inventory = await readAgentFrames(session);

  return inventory.frames;
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

export interface WithheldFrame {
  readonly frameId: string;
  readonly origin: string;
}

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
export const withheldFrameLine = (
  origin: string,
  depth: number,
  ref?: string
): AgentSnapshotLine => ({
  attributes: `[origin withheld: ${origin}]`,
  depth,
  name: '',
  ...(ref === undefined ? {} : { ref }),
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

export interface ScopedSnapshotInput {
  /** The main frame's own accessibility tree. */
  readonly topNodes: readonly AxNode[];
  /** Owner iframe backend node id → frame id, for every child frame. */
  readonly ownerFrameByBackendNodeId: ReadonlyMap<number, string>;
  /** Accessibility trees of the frames the agent may read, keyed by frame id. */
  readonly readableTrees: ReadonlyMap<string, readonly AxNode[]>;
  /** Withheld frame id → origin. */
  readonly withheld: ReadonlyMap<string, string>;
  readonly depth?: number | undefined;
}

export interface ScopedSnapshot {
  readonly lines: readonly AgentSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly truncated: boolean;
  /** Withheld frames whose owner element produced a line of their own. */
  readonly renderedWithheldFrameIds: ReadonlySet<string>;
}

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
  const renderedWithheldFrameIds = new Set<string>();
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
      const withheldOrigin =
        ownerFrameId === undefined ? undefined : input.withheld.get(ownerFrameId);
      const interactive = INTERACTIVE_ROLES.has(role);
      const textRole = TEXT_ROLES.has(role);
      const ignored = node.ignored === true;

      if (!ignored && withheldOrigin === undefined) {
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

      if (withheldOrigin !== undefined) {
        // A withheld frame's owner element is all the agent may see of it: one line carrying a ref (so the frame can be targeted for `read:<origin>`) and the withheld origin, with no child node and no document content. Rendered like the Playwright backend's `- iframe [ref=eN] [origin withheld: <origin>]`.
        const emittedRef = backendNodeId === undefined ? undefined : `e${String(backendNodeId)}`;

        if (emittedRef !== undefined && backendNodeId !== undefined) {
          refs.push({ backendNodeId, ref: emittedRef });
        }

        lines.push(withheldFrameLine(withheldOrigin, atDepth, emittedRef));

        if (ownerFrameId !== undefined) {
          renderedWithheldFrameIds.add(ownerFrameId);
        }

        return;
      }

      if (ownerFrameId !== undefined) {
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

  return { lines, refs, renderedWithheldFrameIds, truncated };
};

/**
 * One frame's CDP channel: the tab's own session for a same-process frame, or
 * the flattened child session of an out-of-process iframe, which is the only
 * way to read that frame's document.
 */
interface FrameChannel {
  /** True when `send` addresses a child session rather than the tab. */
  readonly child: boolean;
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<
    Record<string, unknown> | undefined
  >;
}

const frameChannel = (
  session: Pick<BrowserToolPageSession, 'send'>,
  childSessions: ReadonlyMap<string, string>,
  frameId: string
): FrameChannel => {
  const sessionId = childSessions.get(frameId);

  return sessionId === undefined
    ? { child: false, send: (method, params) => session.send(method, params) }
    : { child: true, send: (method, params) => session.send(method, params, sessionId) };
};

/**
 * Reads one frame's accessibility tree. `undefined` means the frame could not
 * be read at all — the caller then withholds it instead of splicing an empty
 * document, which would hide the frame from the snapshot.
 * A child session reads its own document, so it takes no `frameId`.
 */
const readFrameAxTree = async (
  channel: FrameChannel,
  frameId?: string
): Promise<readonly AxNode[] | undefined> => {
  try {
    const parsed = axTreePayloadSchema.safeParse(
      await channel.send(
        'Accessibility.getFullAXTree',
        frameId === undefined || channel.child ? {} : { frameId }
      )
    );

    return parsed.success ? (parsed.data.nodes ?? []) : undefined;
  } catch {
    // A frame that navigated, detached, or never had a readable session.
    return undefined;
  }
};

const frameOwnerResultSchema = z.object({
  backendNodeId: z.number().optional(),
  nodeId: z.number().optional(),
});

/** One frame's owner element backend node id, or undefined when the frame has no readable owner. */
const readFrameOwner = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frameId: string
): Promise<number | undefined> => {
  try {
    const parsed = frameOwnerResultSchema.safeParse(
      await session.send('DOM.getFrameOwner', { frameId })
    );

    return parsed.success ? parsed.data.backendNodeId : undefined;
  } catch {
    // A frame without an owner node (racing navigation) contributes no anchor.
    return undefined;
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

  for (const frameId of frameIds) {
    // eslint-disable-next-line no-await-in-loop -- CDP is a sequential request/response channel per frame
    const owner = await readFrameOwner(session, frameId);

    if (owner !== undefined) {
      owners.set(frameId, owner);
    }
  }

  return owners;
};

/**
 * The child frame whose owner element is this node. `DOM.describeNode` reports
 * an iframe element as living in its parent's document, so a target that is the
 * iframe itself is mapped to the frame it hosts through `DOM.getFrameOwner`.
 */
export const frameWithOwnerNode = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frames: readonly BrowserAgentFrame[],
  backendNodeId: number
): Promise<BrowserAgentFrame | undefined> => {
  const children = frames.filter(frame => frame.parentId !== undefined);

  if (children.length === 0) {
    return undefined;
  }

  const owners = await readFrameOwners(
    session,
    children.map(frame => frame.id)
  );

  return children.find(frame => owners.get(frame.id) === backendNodeId);
};

/** Every frame below `rootId`, document order, excluding the root itself. */
const descendantFramesOf = (
  frames: readonly BrowserAgentFrame[],
  rootId: string
): readonly BrowserAgentFrame[] => {
  const childrenByParent = new Map<string, BrowserAgentFrame[]>();

  for (const frame of frames) {
    if (frame.parentId !== undefined) {
      const siblings = childrenByParent.get(frame.parentId) ?? [];

      siblings.push(frame);
      childrenByParent.set(frame.parentId, siblings);
    }
  }

  const descendants: BrowserAgentFrame[] = [];
  const visit = (parentId: string): void => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      descendants.push(child);
      visit(child.id);
    }
  };

  visit(rootId);

  return descendants;
};

export interface AgentSnapshotCapture {
  readonly lines: readonly AgentSnapshotLine[];
  readonly refs: readonly BrowserToolRefEntry[];
  readonly text: string;
  readonly truncated: boolean;
  readonly withheldFrames: readonly string[];
  /** Frames whose content this capture included, for the probes that follow it. */
  readonly readableFrameIds: readonly string[];
  /** Flattened child session per out-of-process iframe, so probes read the frame's own process. */
  readonly childSessions?: ReadonlyMap<string, string>;
}

export interface AgentReadScope {
  /** Origins the caller holds `read` for; the main frame is included by the tool gate. */
  readonly readableOrigins: readonly string[];
}

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
 * is spliced into the root frame's tree at its iframe node. The root is the
 * tab's main frame unless `rootFrameId` names a frame the caller targeted (a
 * granted iframe), whose document then becomes the snapshot.
 */
export const captureAgentAriaSnapshot = async (
  session: AgentFrameSession,
  scope: AgentReadScope,
  options: { readonly depth?: number | undefined; readonly rootFrameId?: string | undefined } = {}
): Promise<AgentSnapshotCapture> => {
  const inventory = await readAgentFrames(session);
  const { frames } = inventory;
  const tabChannel: FrameChannel = {
    child: false,
    send: (method, params) => session.send(method, params),
  };

  const root =
    options.rootFrameId === undefined
      ? mainFrameOf(frames)
      : frames.find(frame => frame.id === options.rootFrameId);

  if (root === undefined) {
    // Fail closed on a targeted frame the tab does not know. Without any frame list the tab's own document is still readable: its tree is the one `Accessibility.getFullAXTree` returns for the target, and it never carries a child frame's content, so rendering it leaks nothing.
    const topNodes = frames.length === 0 ? ((await readFrameAxTree(tabChannel)) ?? []) : [];

    if (topNodes.length === 0) {
      return {
        childSessions: inventory.childSessions,
        lines: [],
        readableFrameIds: [],
        refs: [],
        text: '(no accessibility nodes)',
        truncated: false,
        withheldFrames: [],
      };
    }

    const unframed = buildScopedSnapshot({
      ownerFrameByBackendNodeId: new Map(),
      readableTrees: new Map(),
      topNodes,
      withheld: new Map(),
    });

    return {
      childSessions: inventory.childSessions,
      lines: unframed.lines,
      readableFrameIds: [],
      refs: unframed.refs,
      text: unframed.lines.map(renderLine).join('\n'),
      truncated: unframed.truncated,
      withheldFrames: [],
    };
  }

  const withheld = withheldFramesOf(frames, scope.readableOrigins);
  const withheldByFrameId = new Map(withheld.map(frame => [frame.frameId, frame.origin]));

  if (withheldByFrameId.has(root.id)) {
    // Fail closed: a root the caller may not read is not read at all.
    return {
      childSessions: inventory.childSessions,
      lines: [],
      readableFrameIds: [],
      refs: [],
      text: '(no accessibility nodes)',
      truncated: false,
      withheldFrames: withheld.map(frame => frame.origin),
    };
  }

  const descendants = descendantFramesOf(frames, root.id);
  const readableTreeFrames = descendants.filter(frame => !withheldByFrameId.has(frame.id));

  const rootChannel = frameChannel(session, inventory.childSessions, root.id);
  let topNodes = await readFrameAxTree(rootChannel, root.id);

  if (topNodes === undefined && !rootChannel.child) {
    // A failed frame-addressed read falls back to the target's own tree, so a protocol that refuses the parameter cannot blank the page the agent may read.
    topNodes = await readFrameAxTree(rootChannel);
  }

  if (topNodes === undefined) {
    return {
      childSessions: inventory.childSessions,
      lines: [],
      readableFrameIds: [],
      refs: [],
      text: '(no accessibility nodes)',
      truncated: false,
      withheldFrames: withheld.map(frame => frame.origin),
    };
  }

  const readableTrees = new Map<string, readonly AxNode[]>();
  const unreadableFrameIds = new Set<string>();

  for (const frame of readableTreeFrames) {
    const channel = frameChannel(session, inventory.childSessions, frame.id);
    // eslint-disable-next-line no-await-in-loop -- one CDP read per frame, in document order
    const tree = await readFrameAxTree(channel, frame.id);

    if (tree === undefined) {
      // A granted frame that cannot be read is withheld, exactly like an ungranted one: the agent must not infer content from its absence.
      unreadableFrameIds.add(frame.id);
      withheldByFrameId.set(frame.id, frame.origin);
    } else {
      readableTrees.set(frame.id, tree);
    }
  }

  const scopedWithheld = frames
    .filter(frame => withheldByFrameId.has(frame.id))
    .map(frame => ({
      frameId: frame.id,
      origin: withheldByFrameId.get(frame.id) ?? frame.origin,
    }));

  const owners = await readFrameOwners(
    session,
    descendants.map(frame => frame.id)
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
  const lines = [...snapshot.lines];
  const refs = [...snapshot.refs];
  // An out-of-process iframe's owner node need not appear in the tab's own AX tree. Its line still has to name the origin, so the agent learns the frame exists and can target it for `read:<origin>`.
  const unrendered = scopedWithheld.filter(
    frame => !snapshot.renderedWithheldFrameIds.has(frame.frameId)
  );

  for (const frame of unrendered) {
    const owner = owners.get(frame.frameId);

    if (owner !== undefined) {
      refs.push({ backendNodeId: owner, ref: `e${String(owner)}` });
    }

    lines.push(
      withheldFrameLine(frame.origin, 0, owner === undefined ? undefined : `e${String(owner)}`)
    );
  }

  const body =
    lines.length === 0 ? '(no accessibility nodes)' : lines.map(line => renderLine(line)).join('\n');
  const text = snapshot.truncated
    ? `${body}\n... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    : body;

  return {
    childSessions: inventory.childSessions,
    lines,
    readableFrameIds: [
      root.id,
      ...readableTreeFrames
        .filter(frame => !unreadableFrameIds.has(frame.id))
        .map(frame => frame.id),
    ],
    refs,
    text,
    truncated: snapshot.truncated,
    withheldFrames: scopedWithheld.map(frame => frame.origin),
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
      left: content[0] ?? 0,
      top: content[1] ?? 0,
      width: parsed.success ? (parsed.data.model?.width ?? 0) : 0,
    };
  } catch {
    return undefined;
  }
};

const intersectBox = (outer: ScreenshotBox, inner: ScreenshotBox): ScreenshotBox => {
  const left = Math.max(outer.left, inner.left);
  const top = Math.max(outer.top, inner.top);
  const right = Math.min(outer.left + outer.width, inner.left + inner.width);
  const bottom = Math.min(outer.top + outer.height, inner.top + inner.height);

  return { height: Math.max(0, bottom - top), left, top, width: Math.max(0, right - left) };
};

/**
 * The frames whose boxes clip one frame's region, innermost first. `undefined`
 * when an ancestor is missing from the frame list: its box is then unknown,
 * and blacking out the wrong region would leave the frame visible, so the
 * capture fails instead.
 */
const frameChain = (
  frames: readonly BrowserAgentFrame[],
  frameId: string
): readonly string[] | undefined => {
  const parents = new Map<string, string | undefined>();

  for (const frame of frames) {
    parents.set(frame.id, frame.parentId);
  }

  const chain: string[] = [];
  let current: string | undefined = frameId;

  while (current !== undefined) {
    const parent = parents.get(current);

    if (parent === undefined) {
      // The main frame ends the chain; a frame the list never saw cannot be measured.
      return parents.has(current) ? chain : undefined;
    }

    chain.push(current);
    current = parent;
  }

  return undefined;
};

/**
 * The boxes to black out, in the coordinate space the screenshot was captured
 * in. A nested frame's box is clipped by each ancestor frame's box, and
 * `offset` translates document coordinates onto a viewport screenshot.
 */
// eslint-disable-next-line max-params -- the frame tree, the withheld set and the offset are separate boundary inputs
export const readWithheldFrameBoxes = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frames: readonly BrowserAgentFrame[],
  withheld: readonly WithheldFrame[],
  options: { readonly offset?: { readonly x: number; readonly y: number } } = {}
): Promise<{ readonly boxes: readonly ScreenshotBox[] } | { readonly error: string }> => {
  if (withheld.length === 0) {
    return { boxes: [] };
  }

  const owners = await readFrameOwners(
    session,
    frames.filter(frame => frame.parentId !== undefined).map(frame => frame.id)
  );
  const boxes: ScreenshotBox[] = [];
  const offset = options.offset ?? { x: 0, y: 0 };

  for (const frame of withheld) {
    const chain = frameChain(frames, frame.frameId);

    if (chain === undefined) {
      return {
        error: `The region of the ${frame.origin} frame could not be measured, so no screenshot was returned.`,
      };
    }

    let accumulated: ScreenshotBox | undefined = undefined;

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

    // A zero-area frame covers no pixels; nothing to mask.
    if (accumulated !== undefined && accumulated.width > 0 && accumulated.height > 0) {
      boxes.push({
        height: accumulated.height,
        left: accumulated.left + offset.x,
        top: accumulated.top + offset.y,
        width: accumulated.width,
      });
    }
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
 * Drops console messages a withheld frame produced. A `Runtime.consoleAPICalled`
 * entry is attributed to the frame of its execution context; a `Log.entryAdded`
 * entry carries its source URL. An entry with neither is dropped while any frame
 * is withheld, because its producer cannot be established.
 */
export const filterAgentConsoleMessages = (
  messages: readonly BrowserConsoleMessage[],
  withheld: readonly WithheldFrame[]
): readonly BrowserConsoleMessage[] => {
  if (withheld.length === 0) {
    return messages;
  }

  const withheldOrigins = new Set(withheld.map(frame => frame.origin));
  const withheldIds = new Set(withheld.map(frame => frame.frameId));

  return messages.filter(message => {
    if (message.frameId !== undefined) {
      return !withheldIds.has(message.frameId);
    }

    const origin = toBrowserOrigin(message.url);

    return origin === undefined ? false : !withheldOrigins.has(origin);
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

export interface AgentSnapshotView extends AgentSnapshotCapture {
  /** True when the caller may not read at least one frame, so the bridge can say so. */
  readonly hasWithheldFrames: boolean;
}

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
    /** The frame a targeted snapshot starts from; defaults to the tab's main frame. */
    readonly rootFrameId?: string | undefined;
  } = {}
): Promise<AgentSnapshotView> => {
  const capture = await captureAgentAriaSnapshot(session, scope, {
    depth: options.depth,
    ...(options.rootFrameId === undefined ? {} : { rootFrameId: options.rootFrameId }),
  });
  const hiddenText = new Set<string>();
  const sensitiveValues = new Set<string>();

  for (const frameId of capture.readableFrameIds) {
    const channel = frameChannel(session, capture.childSessions ?? new Map(), frameId);

    // eslint-disable-next-line no-await-in-loop -- one probe pair per frame; a frame probe is two CDP round trips
    const hidden = await readFrameHiddenText({ send: channel.send }, frameId);

    for (const text of hidden) {
      hiddenText.add(text);
    }

    // eslint-disable-next-line no-await-in-loop -- see above: probes run per frame
    const values = await readFrameSensitiveValues({ send: channel.send }, frameId);

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

  const body =
    lines.length === 0
      ? '(no accessibility nodes)'
      : lines.map(line => renderLine(line)).join('\n');
  const text = capture.truncated
    ? `${body}\n... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`
    : body;

  return {
    ...(capture.childSessions === undefined ? {} : { childSessions: capture.childSessions }),
    hasWithheldFrames: capture.withheldFrames.length > 0,
    lines,
    readableFrameIds: capture.readableFrameIds,
    refs: capture.refs,
    text: maskSensitiveValues(text, [...sensitiveValues]),
    truncated: capture.truncated,
    withheldFrames: capture.withheldFrames,
  };
};

const layoutMetricsSchema = z.object({
  cssLayoutViewport: z.object({ clientWidth: z.number().optional() }).optional(),
  cssVisualViewport: z
    .object({ pageX: z.number().optional(), pageY: z.number().optional() })
    .optional(),
  layoutViewport: z.object({ clientWidth: z.number().optional() }).optional(),
});

export interface AgentScreenshotGeometry {
  /** Device pixels per CSS pixel, used to scale frame boxes onto the image. */
  readonly scale: number;
  /**
   * The page's scroll position: `DOM.getBoxModel` quads are viewport-relative,
   * while a `Page.captureScreenshot` clip is document-relative, so this is the
   * translation between the two.
   */
  readonly scroll: { readonly x: number; readonly y: number };
}

/**
 * The screenshot's pixel geometry: the device scale factor (the layout
 * viewport is in device pixels, the CSS one in CSS pixels) and the page's
 * scroll position.
 */
export const readAgentScreenshotGeometry = async (
  session: Pick<BrowserToolPageSession, 'send'>
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
    scale,
    scroll: { x: visual?.pageX ?? 0, y: visual?.pageY ?? 0 },
  };
};

/**
 * The document-space boxes of the readable frames' password/payment fields,
 * added to the screenshot mask so a credential never leaves as pixels. A field
 * box is its frame's document origin plus the field's own scroll-adjusted
 * position; a frame whose origin cannot be measured fails the capture rather
 * than guessing.
 */
// eslint-disable-next-line max-params -- the frame tree, the read grants and the offset are separate boundary inputs
export const readSensitiveFieldBoxes = async (
  session: Pick<BrowserToolPageSession, 'send'>,
  frames: readonly BrowserAgentFrame[],
  readableOrigins: readonly string[],
  options: {
    readonly offset?: { readonly x: number; readonly y: number };
    /** Flattened child session per out-of-process iframe, so its own document is probed. */
    readonly childSessions?: ReadonlyMap<string, string>;
  } = {}
): Promise<{ readonly boxes: readonly ScreenshotBox[] } | { readonly error: string }> => {
  const readable = frames.filter(frame =>
    readableOrigins.some(pattern => originPatternMatches(pattern, frame.origin))
  );

  if (readable.length === 0) {
    return { boxes: [] };
  }

  const owners = await readFrameOwners(
    session,
    frames.filter(frame => frame.parentId !== undefined).map(frame => frame.id)
  );
  const offset = options.offset ?? { x: 0, y: 0 };
  const boxes: ScreenshotBox[] = [];

  for (const frame of readable) {
    const channel = frameChannel(session, options.childSessions ?? new Map(), frame.id);
    // eslint-disable-next-line no-await-in-loop -- one probe per frame, in document order
    const probe = await readFrameSensitiveBoxes({ send: channel.send }, frame.id);

    const chain = frameChain(frames, frame.id);

    if (chain === undefined) {
      return {
        error: `The region of a ${frame.origin} form field could not be measured, so no screenshot was returned.`,
      };
    }

    let frameOriginX = 0;
    let frameOriginY = 0;

    for (const frameId of chain) {
      const ownerBackendNodeId = owners.get(frameId);

      if (ownerBackendNodeId === undefined) {
        return {
          error: `The region of a ${frame.origin} form field could not be measured, so no screenshot was returned.`,
        };
      }

      // eslint-disable-next-line no-await-in-loop -- ancestor chain, one box per level
      const box = await readFrameContentBox(session, ownerBackendNodeId);

      if (box === undefined) {
        return {
          error: `The region of a ${frame.origin} form field could not be measured, so no screenshot was returned.`,
        };
      }

      frameOriginX += box.left;
      frameOriginY += box.top;
    }

    if (probe.boxes.length > 0) {
      for (const box of probe.boxes) {
        boxes.push({
          height: box.height,
          left: frameOriginX + box.x + probe.scrollX + offset.x,
          top: frameOriginY + box.y + probe.scrollY + offset.y,
          width: box.width,
        });
      }
    }
  }

  return { boxes };
};
