import { originPatternMatches } from './browser-agent-checks';
import type { IsolatedFrameTree } from './browser-agent-isolated-probe';
import { MAX_BROWSER_TOOL_SNAPSHOT_LINES } from './browser-tool-snapshot';

/**
 * Frame scoping for the scripting backend's snapshot (Firefox, SPEC "Frame
 * scoping"): the page-side walker prints each `<iframe>`/`<frame>` as one line
 * and notes it; this module asks the content-script probe which frame each
 * element hosts, splices in the documents of the frames the agent may read, and
 * marks every other frame line `[origin withheld: <origin>]` as the debugger
 * path does. A frame the agent may not read is never asked for its content.
 */

/** One frame line the page-side walker printed: its line index, depth, document-order owner index and ref. */
export interface ScriptingFramePlaceholder {
  readonly depth: number;
  readonly line: number;
  readonly owner: number;
  readonly ref?: string | undefined;
}

/** One document's snapshot lines, with the frame lines among them. */
export interface ScriptingSnapshotPart {
  readonly frames: readonly ScriptingFramePlaceholder[];
  readonly lines: readonly string[];
}

export interface ScriptingFrameScope {
  /** The tab's frames and the frame each frame element hosts; the call's own read when it has one. */
  readonly frameTree: () => Promise<IsolatedFrameTree | undefined>;
  /** Origins the caller holds `read` for; the main frame was granted before the snapshot ran. */
  readonly readableOrigins: readonly string[];
  /** One readable frame's own snapshot, without refs, at most `maxDepth` levels deep, within `timeoutMs`. */
  readonly readFrame: (
    frameId: number,
    maxDepth: number | undefined,
    timeoutMs: number
  ) => Promise<ScriptingSnapshotPart | undefined>;
}

export interface ScriptingSplice {
  readonly lines: readonly string[];
  /**
   * The refs of the frame lines a readable frame's document replaces. Acting on
   * one would only reach the owner element, so they are dropped as the debugger
   * path does: only a withheld frame's line keeps its ref, for a read request.
   */
  readonly readableFrameRefs: readonly string[];
}

const INDENT = '  ';
const MAIN_FRAME_ID = '0';
/** The origin a withheld line names when the browser could not say which frame an element hosts. */
const UNKNOWN_FRAME_ORIGIN = 'unknown';
/** Frame documents one snapshot reads; every frame after them is withheld. */
export const MAX_SCRIPTING_FRAME_READS = 20;
/** The time every frame read of one snapshot shares; a frame not read by then is withheld. */
export const SCRIPTING_FRAME_READS_DEADLINE_MS = 20_000;

const withheldLine = (line: string, origin: string): string =>
  `${line} [origin withheld: ${origin}]`;

/**
 * The agent's snapshot lines with every child frame resolved. A frame the
 * probe cannot map, or whose origin is not granted, keeps only its withheld
 * line; a readable frame's document follows its frame line one level deeper.
 * A granted frame that is not read (its read failed, or the frame count, time
 * or line budget ran out) is withheld too, so its absence says nothing about
 * its content. The result is capped at the debugger path's line limit.
 */
export const spliceScriptingFrames = async (
  main: ScriptingSnapshotPart,
  maxDepth: number | undefined,
  scope: ScriptingFrameScope
): Promise<ScriptingSplice> => {
  const tree = main.frames.length === 0 ? undefined : await scope.frameTree();
  const frames = new Map(
    (tree?.complete === true ? tree.frames : []).map(frame => [frame.id, frame])
  );
  const readable = (origin: string): boolean =>
    scope.readableOrigins.some(pattern => originPatternMatches(pattern, origin));
  const deadline = Date.now() + SCRIPTING_FRAME_READS_DEADLINE_MS;
  const readableFrameRefs: string[] = [];
  let reads = 0;
  let produced = 0;

  const render = async (
    part: ScriptingSnapshotPart,
    frameId: string,
    base: number
  ): Promise<readonly string[]> => {
    /** One frame line: withheld, or followed by the readable frame's own document one level deeper. */
    const frameLines = async (
      line: string,
      placeholder: ScriptingFramePlaceholder
    ): Promise<readonly string[]> => {
      const childId = tree?.owners.get(frameId)?.[placeholder.owner];
      const child = childId === undefined ? undefined : frames.get(childId);

      if (child === undefined || !readable(child.origin)) {
        return [withheldLine(line, child?.origin ?? UNKNOWN_FRAME_ORIGIN)];
      }

      const depth = base + placeholder.depth + 1;
      const remaining = maxDepth === undefined ? undefined : maxDepth - depth;
      const bare =
        placeholder.ref === undefined ? line : line.replace(` [ref=${placeholder.ref}]`, '');

      if (remaining !== undefined && remaining < 0) {
        if (placeholder.ref !== undefined) {
          readableFrameRefs.push(placeholder.ref);
        }

        return [bare];
      }

      const timeoutMs = deadline - Date.now();
      const withinBudget =
        reads < MAX_SCRIPTING_FRAME_READS &&
        timeoutMs > 0 &&
        produced < MAX_BROWSER_TOOL_SNAPSHOT_LINES;

      if (!withinBudget) {
        return [withheldLine(line, child.origin)];
      }

      reads += 1;

      const inner = await scope.readFrame(Number(child.id), remaining, timeoutMs);

      if (inner === undefined) {
        return [withheldLine(line, child.origin)];
      }

      if (placeholder.ref !== undefined) {
        readableFrameRefs.push(placeholder.ref);
      }

      return [bare, ...(await render(inner, child.id, depth))];
    };
    const placeholders = new Map(part.frames.map(frame => [frame.line, frame]));
    const out: string[] = [];

    for (const [index, line] of part.lines.entries()) {
      const placeholder = placeholders.get(index);
      const indented = `${INDENT.repeat(base)}${line}`;

      produced += 1;

      if (placeholder === undefined) {
        out.push(indented);
      } else {
        // eslint-disable-next-line no-await-in-loop -- frames render in document order, one injection each
        out.push(...(await frameLines(indented, placeholder)));
      }
    }

    return out;
  };

  const lines = await render(main, MAIN_FRAME_ID, 0);

  return {
    lines:
      lines.length > MAX_BROWSER_TOOL_SNAPSHOT_LINES
        ? [
            ...lines.slice(0, MAX_BROWSER_TOOL_SNAPSHOT_LINES),
            `... (snapshot truncated at ${String(MAX_BROWSER_TOOL_SNAPSHOT_LINES)} lines)`,
          ]
        : lines,
    readableFrameRefs,
  };
};
