import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { buildToolDetailSummary } from '@kilocode/app-shared/tool-detail';
import { z } from 'zod';

import { i18n } from '@/i18n';
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
   * translating. The fallback labels are either already-localized UI copy
   * (`read`, `Read todos`) or raw tool ids (`websearch`); sending those to the
   * gateway would translate text that is already in the app language, so the
   * transcript row skips them.
   */
  translatable: boolean;
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
        subtitle: filePath ? getFilename(filePath) : i18n.t('agentChat.toolCard.toolRead'),
        badge,
        translatable: filePath !== '',
      };
    }
    case 'edit': {
      const filePath = fields.filePath ?? '';
      return {
        title: i18n.t('agentChat.toolCard.toolEdit'),
        subtitle: filePath ? getFilename(filePath) : i18n.t('agentChat.toolCard.toolEdit'),
        translatable: filePath !== '',
      };
    }
    case 'write': {
      const filePath = fields.filePath ?? '';
      return {
        title: i18n.t('agentChat.toolCard.toolWrite'),
        subtitle: filePath ? getFilename(filePath) : i18n.t('agentChat.toolCard.toolWrite'),
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
          ? getDirectoryName(resolvedPath)
          : i18n.t('agentChat.toolCard.toolList'),
        translatable: resolvedPath !== '',
      };
    }
    case 'patch':
    case 'apply_patch': {
      const patchText = fields.patchText ?? '';
      const files = patchText ? listPatchFilePaths(patchText) : [];
      let subtitle = i18n.t('agentChat.toolCard.toolPatch');
      if (files.length === 1) {
        subtitle = getFilename(files[0] ?? '');
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
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      const query = fields.query;
      const url = fields.url;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty query must fall back to url; ?? would skip ''
      const search = query || url;
      return {
        title: part.tool,
        subtitle: search ? truncateText(search, 60) : part.tool,
        translatable: Boolean(search),
      };
    }
    case 'todoread': {
      return {
        title: part.tool,
        subtitle: i18n.t('agentChat.toolCard.readTodos'),
        translatable: false,
      };
    }
    case 'todowrite': {
      return {
        title: part.tool,
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
