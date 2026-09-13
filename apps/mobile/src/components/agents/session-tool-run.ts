import { type Part, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type TFunction } from 'i18next';

import { partRendersContent } from './message-visibility';
import { isToolPart } from './part-types';
import { getToolDisplay } from './tool-card-display';

/**
 * Whether a tool part can be collapsed into a condensed run row. `task` renders
 * `ChildSessionSection` and `suggest` renders the live suggestion card, both
 * interactive multi-line content; condensing them would hide that UI, so they
 * end a run instead. A part that renders nothing on the session page
 * (`plan_enter`/`plan_exit`) is never condensable either: a run's count and
 * sheet must match what the per-part path shows.
 */
export function isCondensableToolPart(part: Part): part is ToolPart {
  return (
    isToolPart(part) && partRendersContent(part) && part.tool !== 'task' && part.tool !== 'suggest'
  );
}

export type MessagePartGroup =
  | { kind: 'parts'; parts: Part[] }
  | { kind: 'tool-run'; parts: ToolPart[] };

/** One condensed-run row: the same label and badge the part's card shows alone. */
export type ToolRunRow = {
  id: string;
  label: string;
  badge?: string;
  status: ToolPart['state']['status'];
};

/**
 * Drops invisible parts (exactly the parts `PartRenderer` renders as null), then
 * walks the rest in order. Consecutive condensable tool parts become a single
 * `tool-run` group when `condense` is on and the run has two or more parts; a
 * lone tool part, or any run when `condense` is off, stays a `parts` group of
 * one. A text, reasoning, file, compaction, patch, `task`, or `suggest` part
 * ends the run and starts the next `parts` group.
 */
export function groupMessageParts(
  parts: readonly Part[],
  { condense }: { condense: boolean }
): MessagePartGroup[] {
  const groups: MessagePartGroup[] = [];
  let toolRun: ToolPart[] = [];
  let plain: Part[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 0) {
      return;
    }
    if (condense && toolRun.length >= 2) {
      groups.push({ kind: 'tool-run', parts: toolRun });
    } else {
      for (const part of toolRun) {
        groups.push({ kind: 'parts', parts: [part] });
      }
    }
    toolRun = [];
  };

  const flushPlain = () => {
    if (plain.length === 0) {
      return;
    }
    groups.push({ kind: 'parts', parts: plain });
    plain = [];
  };

  for (const part of parts) {
    if (partRendersContent(part)) {
      if (isCondensableToolPart(part)) {
        flushPlain();
        toolRun.push(part);
      } else {
        flushToolRun();
        plain.push(part);
      }
    }
  }
  flushToolRun();
  flushPlain();
  return groups;
}

/**
 * One row per part, in order. `label` is the part's own fixed-row label
 * (`display.subtitle ?? display.title`), so a condensed row's label equals what
 * the part would show on its own.
 */
export function buildToolRunRows(parts: readonly ToolPart[]): ToolRunRow[] {
  return parts.map(part => {
    const display = getToolDisplay(part);
    const row: ToolRunRow = {
      id: part.id,
      label: display.subtitle ?? display.title,
      status: part.state.status,
    };
    if (display.badge !== undefined) {
      row.badge = display.badge;
    }
    return row;
  });
}

/** The condensed row label: item count plus the last tool call's own label. */
export function buildToolRunLabel(rows: readonly ToolRunRow[], t: TFunction): string {
  return t('agentChat.toolRun.condensedLabel', {
    itemCount: rows.length,
    last: rows.at(-1)?.label ?? '',
  });
}
