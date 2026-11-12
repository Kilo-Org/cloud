import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { buildToolDetailSummary } from '@kilocode/app-shared/tool-detail';

import { i18n } from '@/i18n';
import { truncateText } from './tool-card-utils';

export type ToolDisplay = {
  title: string;
  subtitle?: string;
  badge?: string;
  /**
   * Whether the shown label (`subtitle ?? title`) carries tool content worth
   * translating. The fallback labels are already-localized UI copy (`read`,
   * `searching online`, `Read plan`); sending those to the gateway would
   * translate text that is already in the app language, so the transcript row
   * skips them.
   */
  translatable: boolean;
  /**
   * Whether the part-detail header shows `title` alone instead of
   * `<title>: <subtitle>`. Set it when the sheet body renders the subtitle
   * itself: the file chip already names the sent file, so the header repeating
   * the name adds nothing.
   */
  headerTitleOnly?: boolean;
};

/** The search tools whose row title names the tool from the catalog. */
const SEARCH_TOOL_LABEL_KEYS = {
  websearch: 'agentChat.toolCard.toolWebSearch',
  codesearch: 'agentChat.toolCard.toolCodeSearch',
  webfetch: 'agentChat.toolCard.toolWebFetch',
} as const;

/**
 * A search tool row: the title names the tool from the catalog — the same key
 * the permission card's subject uses — and the subtitle carries the query or
 * URL. A call with neither repeats the label, as the other rows do.
 */
export function searchToolDisplay(
  tool: keyof typeof SEARCH_TOOL_LABEL_KEYS,
  fields: Readonly<{ query?: string; url?: string }>
): ToolDisplay {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty query must fall back to url; ?? would skip ''
  const search = fields.query || fields.url;
  const label = i18n.t(SEARCH_TOOL_LABEL_KEYS[tool]);
  return {
    title: label,
    subtitle: search ? truncateText(search, 60) : label,
    translatable: Boolean(search),
  };
}

/**
 * The row a call gets when its own body has no dedicated presentation: the
 * state title or argument summary the tool reported, under `title`.
 */
export function summaryToolDisplay(part: ToolPart, title: string): ToolDisplay {
  const state = part.state;
  const stateTitle =
    state.status === 'running' || state.status === 'completed' ? state.title : undefined;
  const detail = buildToolDetailSummary(part);
  const summary = detail.name === part.tool ? detail.summary : undefined;
  // A tool that reports its own id as the state title names nothing the reader
  // can use, so the row keeps the catalog name instead. Any other state title is
  // the tool's own prose and stays.
  const reported =
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a whitespace-only state title must fall through to the projected name; ?? would keep it
    stateTitle?.trim() || (summary !== undefined ? truncateText(summary, 60) : detail.name);
  const showsRawId = reported === part.tool;
  return {
    title,
    subtitle: showsRawId ? title : reported,
    // The state title and the projected argument summary are agent prose.
    // A known-tool label (`Publish Image`) is raw English app copy with no
    // catalog, so it must reach the gateway like agent prose; a raw tool id
    // or an `mcp` `server/tool` identifier is an id and stays out, like the
    // already-localized fallback labels above.
    translatable:
      !showsRawId && (Boolean(stateTitle?.trim()) || summary !== undefined || detail.nameIsLabel),
  };
}
