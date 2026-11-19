import type { AgentBoard, AgentBoardMessage } from '@kilocode/session-ingest-contracts';

const MAIN = 'main';
const ALL = 'ALL';
const AVATAR_COLORS = 8;
const MIN_LIT = 6;
const MAX_LIT = 9;
const HALF_CELLS = 15;

export type AgentBoardParticipant =
  | { kind: 'main'; label: string }
  | { kind: 'agent'; sessionId: string; label: string; color: number; cells: readonly number[] };

export type AgentBoardRow = {
  id: string;
  from: AgentBoardParticipant;
  to: { label: string; participants: readonly AgentBoardParticipant[] };
  body: string;
};

function fnv(input: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < input.length; index++)
    hash = Math.imul(hash ^ input.charCodeAt(index), 16777619) >>> 0;
  return hash;
}

// Mirror three columns into a five-column grid. A half-cell index is row * 3 + min(column, 4 - column).
function expand(half: (index: number) => boolean) {
  return Array.from({ length: 25 }, (_, index) => index).filter(index => {
    const x = index % 5;
    return half(Math.floor(index / 5) * 3 + Math.min(x, 4 - x));
  });
}

/** Port of the Kilo UI agent avatar identity, so the same agent has the same glyph in every client. */
export function agentAvatarIdentity(id: string) {
  const shape = fnv(id, 2166136261);
  const tone = fnv(id, 0x9747b28c);
  const count = MIN_LIT + (tone % (MAX_LIT - MIN_LIT + 1));
  const rank = (index: number) => Math.imul(shape ^ (index + 1), 0x27d4eb2d) >>> 0;
  const lit = new Set([2 + (shape % 5) * 3]);
  while (lit.size < count) {
    const edge = Array.from({ length: HALF_CELLS }, (_, index) => index).filter(index => {
      // Half-cells 0 and 12 are grid corners, which the round avatar does not draw.
      if (lit.has(index) || index === 0 || index === 12) return false;
      const row = Math.floor(index / 3);
      const col = index % 3;
      return (
        (col > 0 && lit.has(index - 1)) ||
        (col < 2 && lit.has(index + 1)) ||
        (row > 0 && lit.has(index - 3)) ||
        (row < 4 && lit.has(index + 3))
      );
    });
    lit.add(edge.reduce((best, index) => (rank(index) > rank(best) ? index : best)));
  }
  return { color: (tone >>> 4) % AVATAR_COLORS, cells: expand(index => lit.has(index)) };
}

/** Siblings keep their hashed color while it is free, so the first eight never share one. */
function assignColors(ids: readonly string[]) {
  const used = new Set<number>();
  const colors = new Map<string, number>();
  for (const id of ids) {
    if (used.size >= AVATAR_COLORS) used.clear();
    const base = agentAvatarIdentity(id).color;
    const color =
      Array.from({ length: AVATAR_COLORS }, (_, step) => (base + step) % AVATAR_COLORS).find(
        hue => !used.has(hue)
      ) ?? base;
    used.add(color);
    colors.set(id, color);
  }
  return colors;
}

/** Projects the newest board page into display rows. Kilo orders the page oldest first. */
export function projectAgentBoard(board: AgentBoard): AgentBoardRow[] {
  const labels = new Map<string, string>();
  const agentIds: string[] = [];
  const see = (id: string, label: string | undefined) => {
    if (id === MAIN || id === ALL) return;
    if (!labels.has(id)) agentIds.push(id);
    if (label?.trim() || !labels.has(id)) labels.set(id, label?.trim() || 'Agent');
  };
  for (const message of board.messages) {
    see(message.from, message.fromLabel);
    see(message.to, message.toLabel);
  }
  const colors = assignColors(agentIds);
  const main: AgentBoardParticipant = { kind: 'main', label: 'Primary agent' };
  const participant = (id: string): AgentBoardParticipant =>
    id === MAIN
      ? main
      : {
          kind: 'agent',
          sessionId: id,
          label: labels.get(id) ?? 'Agent',
          color: colors.get(id) ?? agentAvatarIdentity(id).color,
          cells: agentAvatarIdentity(id).cells,
        };
  // A message to all agents reaches the participants seen so far, not agents that join later.
  const present = new Set([MAIN]);
  return board.messages.map((message: AgentBoardMessage) => {
    present.add(message.from);
    if (message.to !== ALL) present.add(message.to);
    return {
      id: message.id,
      from: participant(message.from),
      to:
        message.to === ALL
          ? {
              label: 'All agents',
              participants: [...present].filter(id => id !== message.from).map(participant),
            }
          : { label: participant(message.to).label, participants: [participant(message.to)] },
      body: message.body,
    };
  });
}
