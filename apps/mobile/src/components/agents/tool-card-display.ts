import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { buildToolDetailSummary } from '@kilocode/app-shared/tool-detail';
import { z } from 'zod';

import { i18n } from '@/i18n';
import { cloudAgentFileLabel } from '@kilocode/app-shared/cloud-agent';
import { formatList, formatNumber } from '@/lib/format';
import { getToolFileAttachments, getToolImageAttachments } from './tool-card-attachments';
import { getDirectoryName, getFilename, truncateText } from './tool-card-utils';
import { listPatchFilePaths } from './tool-patch-model';
import { buildResultRowsModel } from './tool-list-model';
import { suggestionToolMetadataSchema } from './suggestion-card-state';

export type ToolDisplay = {
  title: string;
  subtitle?: string;
  badge?: string;
  /**
   * Whether the shown label (`subtitle ?? title`) carries tool content worth
   * translating. The fallback labels are already-localized UI copy (`read`,
   * `searching the web`, `Read plan`); sending those to the gateway would
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

function countResultRows(output: string, kind: 'grep' | 'glob'): number {
  return buildResultRowsModel(output, kind).rows.length;
}

/** Zod's validation `.catch()` fallback, not a Promise catch. */
function tolerant<T>(schema: z.ZodType<T>, fallback: T): z.ZodType<T> {
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod schema fallback, not a Promise
  return schema.catch(fallback);
}

const optionalString = tolerant(z.string().optional(), undefined);
const optionalNumber = tolerant(z.number().optional(), undefined);

/**
 * Tool input arrives as arbitrary, tool-defined JSON. Each field below is
 * independently tolerant: a wrong-typed or missing value falls back to
 * `undefined` rather than rejecting the whole payload.
 */
const toolInputSchema = z.object({
  filePath: optionalString,
  path: optionalString,
  offset: optionalNumber,
  limit: optionalNumber,
  command: optionalString,
  description: optionalString,
  pattern: optionalString,
  include: optionalString,
  patchText: optionalString,
  query: optionalString,
  url: optionalString,
  prompt: optionalString,
  suggest: optionalString,
});

/**
 * A search tool row: the title names the tool from the catalog — the same key
 * the permission card's subject uses — and the subtitle carries the query or
 * URL. A call with neither repeats the label, as the other rows do.
 */
function searchToolDisplay(
  fields: z.infer<typeof toolInputSchema>,
  labelKey:
    | 'agentChat.toolCard.toolWebSearch'
    | 'agentChat.toolCard.toolCodeSearch'
    | 'agentChat.toolCard.toolWebFetch'
): ToolDisplay {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty query must fall back to url; ?? would skip ''
  const search = fields.query || fields.url;
  const label = i18n.t(labelKey);
  return {
    title: label,
    subtitle: search ? truncateText(search, 60) : label,
    translatable: Boolean(search),
  };
}

/**
 * Pure row projection for a tool part. The strings and badge rules are copied
 * verbatim from the tool-card bodies so the fixed row renders exactly what the
 * cards render today.
 */
export function getToolDisplay(part: ToolPart): ToolDisplay {
  const input = part.state.input;
  const status = part.state.status;
  const fields = toolInputSchema.parse(input);

  switch (part.tool) {
    case 'read': {
      const filePath = fields.filePath ?? '';
      const offset = fields.offset;
      const limit = fields.limit;

      const badgeParts: string[] = [];
      if (offset !== undefined) {
        badgeParts.push(`L${offset}`);
      }
      if (limit !== undefined) {
        badgeParts.push(
          // i18n-dup-ok: 'agentChat.toolCard.linesBadge_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
          i18n.t('agentChat.toolCard.linesBadge', {
            count: limit,
            displayCount: formatNumber(limit, i18n.language),
          })
        );
      }
      const badge = badgeParts.length > 0 ? formatList(badgeParts, i18n.language) : undefined;

      return {
        title: i18n.t('agentChat.toolCard.toolRead'),
        subtitle: filePath
          ? getFilename(cloudAgentFileLabel(filePath))
          : i18n.t('agentChat.toolCard.toolRead'),
        badge,
        translatable: filePath !== '',
      };
    }
    case 'edit': {
      const filePath = fields.filePath ?? '';
      return {
        title: i18n.t('agentChat.toolCard.toolEdit'),
        subtitle: filePath
          ? getFilename(cloudAgentFileLabel(filePath))
          : i18n.t('agentChat.toolCard.toolEdit'),
        translatable: filePath !== '',
      };
    }
    case 'write': {
      const filePath = fields.filePath ?? '';
      return {
        title: i18n.t('agentChat.toolCard.toolWrite'),
        subtitle: filePath
          ? getFilename(cloudAgentFileLabel(filePath))
          : i18n.t('agentChat.toolCard.toolWrite'),
        translatable: filePath !== '',
      };
    }
    case 'bash': {
      const command = fields.command ?? '';
      const description = fields.description;
      const subtitle =
        description ??
        (command ? truncateText(command, 60) : i18n.t('agentChat.toolCard.toolBash'));
      return {
        title: i18n.t('agentChat.toolCard.toolBash'),
        subtitle,
        translatable: description !== undefined || command !== '',
      };
    }
    case 'glob': {
      const pattern = fields.pattern ?? '';
      const output = status === 'completed' ? part.state.output : undefined;
      const matchCount = output ? countResultRows(output, 'glob') : undefined;
      // i18n-dup-ok: 'agentChat.toolCard.filesBadge_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
      const badge =
        matchCount !== undefined && matchCount > 0
          ? i18n.t('agentChat.toolCard.filesBadge', {
              count: matchCount,
              displayCount: formatNumber(matchCount, i18n.language),
            })
          : undefined;
      return {
        title: i18n.t('agentChat.toolCard.toolGlob'),
        subtitle: pattern || i18n.t('agentChat.toolCard.toolGlob'),
        badge,
        translatable: pattern !== '',
      };
    }
    case 'grep': {
      const pattern = fields.pattern ?? '';
      const include = fields.include;
      let subtitle = pattern || i18n.t('agentChat.toolCard.toolGrep');
      if (include) {
        subtitle += ` (${include})`;
      }
      const output = status === 'completed' ? part.state.output : undefined;
      const matchCount = output ? countResultRows(output, 'grep') : undefined;
      // i18n-dup-ok: 'agentChat.toolCard.matchesBadge_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules.
      const badge =
        matchCount !== undefined && matchCount > 0
          ? i18n.t('agentChat.toolCard.matchesBadge', {
              count: matchCount,
              displayCount: formatNumber(matchCount, i18n.language),
            })
          : undefined;
      return {
        title: i18n.t('agentChat.toolCard.toolGrep'),
        subtitle,
        badge,
        translatable: pattern !== '',
      };
    }
    case 'list': {
      const filePath = fields.filePath;
      const path = fields.path;
      const resolvedPath = filePath ?? path ?? '';
      return {
        title: i18n.t('agentChat.toolCard.toolList'),
        subtitle: resolvedPath
          ? getDirectoryName(cloudAgentFileLabel(resolvedPath))
          : i18n.t('agentChat.toolCard.toolList'),
        translatable: resolvedPath !== '',
      };
    }
    case 'send_file': {
      // The attachment names the file once the delivery completes; until then
      // the input path is the only name the call carries.
      const attachmentName = getToolFileAttachments(part)[0]?.filename ?? '';
      const path = fields.filePath ?? fields.path;
      const pathName = path ? getFilename(cloudAgentFileLabel(path)) : '';
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty attachment name must fall through to the input path; ?? would keep the blank
      const name = attachmentName || pathName;
      const subtitle = name === '' ? undefined : name;
      // Only a finished call reports the outcome. A call that is still running,
      // or that failed, carries the tool's own action label, like the read,
      // edit and write rows, so it never claims a delivery that did not happen.
      if (status !== 'completed') {
        return {
          title: i18n.t('agentChat.toolCard.toolSendFileAction'),
          subtitle,
          translatable: name !== '',
        };
      }
      return {
        title: i18n.t('agentChat.toolCard.toolSendFile'),
        subtitle,
        translatable: name !== '',
        // The sheet body's file chip already names the file, so the header
        // shows this label alone rather than repeating the name below it.
        headerTitleOnly: true,
      };
    }
    case 'patch':
    case 'apply_patch': {
      const patchText = fields.patchText ?? '';
      const files = patchText ? listPatchFilePaths(patchText) : [];
      let subtitle = i18n.t('agentChat.toolCard.toolPatch');
      if (files.length === 1) {
        subtitle = getFilename(cloudAgentFileLabel(files[0] ?? ''));
      } else if (files.length > 1) {
        subtitle = i18n.t('agentChat.toolCard.filesBadge', {
          count: files.length,
          displayCount: formatNumber(files.length, i18n.language),
        });
      }
      return {
        title: i18n.t('agentChat.toolCard.toolPatch'),
        subtitle,
        translatable: files.length === 1,
      };
    }
    case 'websearch': {
      return searchToolDisplay(fields, 'agentChat.toolCard.toolWebSearch');
    }
    case 'codesearch': {
      return searchToolDisplay(fields, 'agentChat.toolCard.toolCodeSearch');
    }
    case 'webfetch': {
      return searchToolDisplay(fields, 'agentChat.toolCard.toolWebFetch');
    }
    case 'todoread': {
      return {
        title: i18n.t('agentChat.toolCard.toolTodo'),
        subtitle: i18n.t('agentChat.toolCard.readTodos'),
        translatable: false,
      };
    }
    case 'todowrite': {
      return {
        title: i18n.t('agentChat.toolCard.toolTodo'),
        subtitle: i18n.t('agentChat.toolCard.updateTodos'),
        translatable: false,
      };
    }
    case 'task': {
      const description = fields.description;
      const prompt = fields.prompt;
      const subtitle =
        description ?? (prompt ? truncateText(prompt, 60) : i18n.t('agentChat.toolCard.toolTask'));
      return {
        title: i18n.t('agentChat.toolCard.toolTask'),
        subtitle,
        translatable: description !== undefined || Boolean(prompt),
      };
    }
    case 'suggest': {
      const metadata =
        status === 'completed' ? suggestionToolMetadataSchema.safeParse(part.state.metadata) : null;
      const dismissed = metadata?.success && metadata.data.dismissed;
      const title = i18n.t('agentChat.suggestion.title');
      let subtitle = fields.suggest?.trim() ?? title;
      const suggestionText = subtitle;
      if (status === 'error' || dismissed) {
        subtitle = i18n.t('agentChat.suggestion.dismissed');
      } else if (subtitle === '') {
        subtitle = title;
      }
      return {
        title,
        subtitle,
        translatable:
          status !== 'error' && !dismissed && suggestionText !== '' && suggestionText !== title,
      };
    }
    default: {
      const stateTitle =
        status === 'running' || status === 'completed' ? part.state.title : undefined;
      const detail = buildToolDetailSummary(part);
      const summary = detail.name === part.tool ? detail.summary : undefined;
      return {
        title: part.tool,
        subtitle:
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a whitespace-only state title must fall through to the projected name; ?? would keep it
          stateTitle?.trim() || (summary !== undefined ? truncateText(summary, 60) : detail.name),
        // The state title and the projected argument summary are agent prose.
        // A known-tool label (`Publish Image`) is raw English app copy with no
        // catalog, so it must reach the gateway like agent prose; a raw tool id
        // or an `mcp` `server/tool` identifier is an id and stays out, like the
        // already-localized fallback labels above.
        translatable: Boolean(stateTitle?.trim()) || summary !== undefined || detail.nameIsLabel,
      };
    }
  }
}

export function toolPartHasDetails(part: ToolPart): boolean {
  if (Object.keys(part.state.input).length > 0) {
    return true;
  }
  if (part.state.status === 'completed' && part.state.output.length > 0) {
    return true;
  }
  if (part.state.status === 'error' && part.state.error.length > 0) {
    return true;
  }
  return getToolImageAttachments(part).length + getToolFileAttachments(part).length > 0;
}
