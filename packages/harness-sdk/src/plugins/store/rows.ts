import { createAssert } from 'typia';
import type { Effort } from '../../core/model.js';
import type { StoredSession } from '../../core/storage.js';
import type { TurnPart, TurnRole } from '../../core/turn.js';

/**
 * What comes back off the disk, and what it means.
 *
 * A drizzle type states what the schema declares, not what the file on disk
 * holds: a database written by an older build, or by another program, still
 * arrives as `unknown`. So every row is asserted here before the package
 * believes any of it.
 */

/** The rows this store reads back, stated so they can be validated at the edge. */
interface SessionRow {
  readonly id: string;
  readonly system: string;
  readonly model: string;
  readonly effort: Effort | null;
  readonly maxTokens: number | null;
  readonly prompted: number | null;
  /** A JSON array of tool names, as `toolsIn` writes it. */
  readonly tools: string | null;
}

interface TurnRow {
  readonly id: string;
  readonly sessionId: string;
  readonly role: TurnRole;
}

interface PartRow {
  readonly id: string;
  readonly turnId: string;
  readonly kind: TurnPart['kind'];
  readonly body: string;
  readonly media: string | null;
  readonly signature: string | null;
  readonly callId: string | null;
  readonly name: string | null;
  readonly failed: boolean | null;
}

const assertSessions = createAssert<readonly SessionRow[]>();
const assertTurns = createAssert<readonly TurnRow[]>();
const assertParts = createAssert<readonly PartRow[]>();

/**
 * The tool names a session offers. A column that holds anything but a list of
 * strings is a row this package did not write, so it is refused rather than
 * repaired: a session opened with the wrong tools sends the wrong prefix.
 */
const assertNames = createAssert<readonly string[]>();

/**
 * Both halves of a tool call name the call they belong to. Neither is any use
 * without it: a call with no identifier cannot be answered, and a result with
 * none answers nothing, and every shape refuses the pair.
 */
const asToolPart = (row: PartRow, kind: 'toolCall' | 'toolResult'): TurnPart => {
  if (row.callId === null) {
    throw new Error(`the ${kind} part ${row.id} names no call`);
  }
  if (kind === 'toolResult') {
    return { id: row.id, kind, body: row.body, callId: row.callId, failed: row.failed === true };
  }
  if (row.name === null) {
    throw new Error(`the toolCall part ${row.id} names no tool`);
  }
  return { id: row.id, kind, body: row.body, callId: row.callId, name: row.name };
};

/**
 * A row is one part, and only an image names a media type. A row that claims to
 * be an image without one is a row this package did not write, so it is refused
 * rather than repaired.
 */
const asPart = (row: PartRow): TurnPart => {
  if (row.kind === 'reasoning') {
    return {
      id: row.id,
      kind: 'reasoning',
      body: row.body,
      ...(row.signature === null ? {} : { signature: row.signature }),
    };
  }
  if (row.kind === 'toolCall' || row.kind === 'toolResult') {
    return asToolPart(row, row.kind);
  }
  if (row.kind !== 'image') {
    return { id: row.id, kind: row.kind, body: row.body };
  }
  if (row.media === null) {
    throw new Error(`the image part ${row.id} names no media type`);
  }
  return { id: row.id, kind: 'image', body: row.body, media: row.media };
};

/** Groups the parts by turn in one pass, so joining them back on costs no scan. */
const byTurn = (rows: readonly PartRow[]): Map<string, TurnPart[]> => {
  const held = new Map<string, TurnPart[]>();
  for (const row of rows) {
    const already = held.get(row.turnId);
    const part = asPart(row);
    if (already === undefined) {
      held.set(row.turnId, [part]);
    } else {
      already.push(part);
    }
  }
  return held;
};

/** A column with no value is a value the caller never named, which is absent here. */
const asStoredSession = (row: SessionRow): StoredSession => ({
  id: row.id,
  system: row.system,
  model: row.model,
  ...(row.effort === null ? {} : { effort: row.effort }),
  ...(row.maxTokens === null ? {} : { maxTokens: row.maxTokens }),
  ...(row.prompted === null ? {} : { prompted: row.prompted }),
  ...(row.tools === null ? {} : { tools: assertNames(JSON.parse(row.tools)) }),
});

/** The tool names as one column. A session that names none leaves it empty. */
const toolsIn = (names: readonly string[] | undefined): string | undefined =>
  names === undefined || names.length === 0 ? undefined : JSON.stringify(names);

export { assertParts, assertSessions, assertTurns, asStoredSession, byTurn, toolsIn };
