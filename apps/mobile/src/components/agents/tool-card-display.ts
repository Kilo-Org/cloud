import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { getToolFileAttachments, getToolImageAttachments } from './tool-card-attachments';
import {
  getDirectoryName,
  getFilename,
  getGenericToolTitle,
  truncateText,
} from './tool-card-utils';
import { listPatchFilePaths } from './tool-patch-model';
import { buildResultRowsModel } from './tool-list-model';

export type ToolDisplay = {
  title: string;
  subtitle?: string;
  badge?: string;
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
        badgeParts.push(`${limit} lines`);
      }
      const badge = badgeParts.length > 0 ? badgeParts.join(', ') : undefined;

      return { title: 'read', subtitle: filePath ? getFilename(filePath) : 'read', badge };
    }
    case 'edit': {
      const filePath = fields.filePath ?? '';
      return { title: 'edit', subtitle: filePath ? getFilename(filePath) : 'edit' };
    }
    case 'write': {
      const filePath = fields.filePath ?? '';
      return { title: 'write', subtitle: filePath ? getFilename(filePath) : 'write' };
    }
    case 'bash': {
      const command = fields.command ?? '';
      const description = fields.description;
      const subtitle = description ?? (command ? truncateText(command, 60) : 'bash');
      return { title: 'bash', subtitle };
    }
    case 'glob': {
      const pattern = fields.pattern ?? '';
      const output = status === 'completed' ? part.state.output : undefined;
      const matchCount = output ? countResultRows(output, 'glob') : undefined;
      const badge = matchCount !== undefined && matchCount > 0 ? `${matchCount} files` : undefined;
      return { title: 'glob', subtitle: pattern || 'glob', badge };
    }
    case 'grep': {
      const pattern = fields.pattern ?? '';
      const include = fields.include;
      let subtitle = pattern || 'grep';
      if (include) {
        subtitle += ` (${include})`;
      }
      const output = status === 'completed' ? part.state.output : undefined;
      const matchCount = output ? countResultRows(output, 'grep') : undefined;
      const badge =
        matchCount !== undefined && matchCount > 0 ? `${matchCount} matches` : undefined;
      return { title: 'grep', subtitle, badge };
    }
    case 'list': {
      const filePath = fields.filePath;
      const path = fields.path;
      const resolvedPath = filePath ?? path ?? '';
      return { title: 'list', subtitle: resolvedPath ? getDirectoryName(resolvedPath) : 'list' };
    }
    case 'patch':
    case 'apply_patch': {
      const patchText = fields.patchText ?? '';
      const files = patchText ? listPatchFilePaths(patchText) : [];
      let subtitle = 'patch';
      if (files.length === 1) {
        subtitle = getFilename(files[0] ?? '');
      } else if (files.length > 1) {
        subtitle = `${files.length} files`;
      }
      return { title: 'patch', subtitle };
    }
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      const query = fields.query;
      const url = fields.url;
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty query must fall back to url; ?? would skip ''
      const search = query || url;
      return { title: part.tool, subtitle: search ? truncateText(search, 60) : part.tool };
    }
    case 'todoread': {
      return { title: part.tool, subtitle: 'Read todos' };
    }
    case 'todowrite': {
      return { title: part.tool, subtitle: 'Update todos' };
    }
    case 'task': {
      const description = fields.description;
      const prompt = fields.prompt;
      const subtitle = description ?? (prompt ? truncateText(prompt, 60) : 'task');
      return { title: 'task', subtitle };
    }
    case 'suggest': {
      return {
        title: 'Suggestion',
        subtitle: status === 'error' ? 'Suggestion dismissed' : 'Suggestion',
      };
    }
    default: {
      const stateTitle =
        status === 'running' || status === 'completed' ? part.state.title : undefined;
      return { title: part.tool, subtitle: getGenericToolTitle(part.tool, stateTitle, input) };
    }
  }
}

/**
 * Whether a tool part has content that a detail sheet could show. Suggest parts
 * are never detailed. Everything else is detailed when input, completed output,
 * error content, or any attachment exists.
 */
export function toolPartHasDetails(part: ToolPart): boolean {
  if (part.tool === 'suggest') {
    return false;
  }
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
