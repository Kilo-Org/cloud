import { originPatternMatches } from './browser-agent-checks';
import { readIsolatedFrames } from './browser-agent-isolated-probe';
import type { IsolatedAgentProbe } from './browser-agent-isolated-probe';

/**
 * Frame scoping for the scripting backend's snapshot (Firefox, SPEC "Frame
 * scoping"): the page-side walker prints each `<iframe>`/`<frame>` as one line
 * and notes it; this module asks the content-script probe which frame each
 * element hosts, splices in the documents of the frames the agent may read, and
 * marks every other frame line `[origin withheld: <origin>]` as the debugger
 * path does. A frame the agent may not read is never asked for its content.
 */

/** One frame line the page-side walker printed: its line index, depth and document-order owner index. */
export interface ScriptingFramePlaceholder {
  readonly depth: number;
  readonly line: number;
  readonly owner: number;
}

/** One document's snapshot lines, with the frame lines among them. */
export interface ScriptingSnapshotPart {
  readonly frames: readonly ScriptingFramePlaceholder[];
  readonly lines: readonly string[];
}

export interface ScriptingFrameScope {
  readonly probe: IsolatedAgentProbe | undefined;
  /** Origins the caller holds `read` for; the main frame was granted before the snapshot ran. */
  readonly readableOrigins: readonly string[];
  /** One readable frame's own snapshot, without refs, at most `maxDepth` levels deep. */
  readonly readFrame: (
    frameId: number,
    maxDepth: number | undefined
  ) => Promise<ScriptingSnapshotPart | undefined>;
}

const INDENT = '  ';
const MAIN_FRAME_ID = '0';
/** The origin a withheld line names when the browser could not say which frame an element hosts. */
const UNKNOWN_FRAME_ORIGIN = 'unknown';

const withheldLine = (line: string, origin: string): string =>
  `${line} [origin withheld: ${origin}]`;

/**
 * The agent's snapshot lines with every child frame resolved. A frame the
 * probe cannot map, or whose origin is not granted, keeps only its withheld
 * line; a readable frame's document follows its frame line one level deeper.
 */
export const spliceScriptingFrames = async (
  main: ScriptingSnapshotPart,
  maxDepth: number | undefined,
  scope: ScriptingFrameScope
): Promise<readonly string[]> => {
  if (main.frames.length === 0) {
    return main.lines;
  }

  const tree = scope.probe === undefined ? undefined : await readIsolatedFrames(scope.probe);
  const frames = new Map(
    (tree?.complete === true ? tree.frames : []).map(frame => [frame.id, frame])
  );
  const readable = (origin: string): boolean =>
    scope.readableOrigins.some(pattern => originPatternMatches(pattern, origin));

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
      const inner =
        remaining !== undefined && remaining < 0
          ? undefined
          : await scope.readFrame(Number(child.id), remaining);

      return inner === undefined ? [line] : [line, ...(await render(inner, child.id, depth))];
    };
    const placeholders = new Map(part.frames.map(frame => [frame.line, frame]));
    const out: string[] = [];

    for (const [index, line] of part.lines.entries()) {
      const placeholder = placeholders.get(index);
      const indented = `${INDENT.repeat(base)}${line}`;

      if (placeholder === undefined) {
        out.push(indented);
      } else {
        // eslint-disable-next-line no-await-in-loop -- frames render in document order, one injection each
        out.push(...(await frameLines(indented, placeholder)));
      }
    }

    return out;
  };

  return render(main, MAIN_FRAME_ID, 0);
};
