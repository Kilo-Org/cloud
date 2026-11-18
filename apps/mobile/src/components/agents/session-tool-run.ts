import { type Part, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type TFunction } from 'i18next';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';
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
  /** The display projection's translation provenance for `label`. */
  translatable: boolean;
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
      translatable: display.translatable,
      status: part.state.status,
    };
    if (display.badge !== undefined) {
      row.badge = display.badge;
    }
    return row;
  });
}

/**
 * The condensed row label: item count plus the last tool call's own summary.
 * `last` is that summary as the row will show it, so the caller passes the
 * translated text when tool translation is on. Defaults to the projection's
 * label for callers with no translation in play. The `count` drives i18next's
 * plural selection and `itemCount` is the localized number the copy renders.
 */
export function buildToolRunLabel(
  rows: readonly ToolRunRow[],
  t: TFunction,
  last: string = rows.at(-1)?.label ?? ''
): string {
  // i18n-dup-ok: 'agentChat.toolRun.condensedLabel_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
  return t('agentChat.toolRun.condensedLabel', {
    count: rows.length,
    itemCount: formatNumber(rows.length, i18n.language),
    last,
  });
}

/**
 * The condensed row label while the last summary is still being translated:
 * the copy's own count phrase, with the summary and the separator that would
 * introduce it removed. Built from `condensedLabel` so the count needs no
 * second string to translate. Every catalog writes a semicolon — Arabic its own
 * `؛` — immediately before `{{last}}`, so dropping that separator leaves the
 * count alone in all of them. Like `buildToolRunLabel`, `count` drives i18next's
 * plural selection and `itemCount` is the localized number the copy renders, so
 * the pending label inflects exactly as the resolved one will.
 */
export function buildToolRunCountLabel(rows: readonly ToolRunRow[], t: TFunction): string {
  // i18n-dup-ok: 'agentChat.toolRun.condensedLabel_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
  const countPhrase = t('agentChat.toolRun.condensedLabel', {
    count: rows.length,
    itemCount: formatNumber(rows.length, i18n.language),
    last: '',
  });
  return countPhrase.replace(/\s*[;\u061B]+\s*$/u, '');
}
