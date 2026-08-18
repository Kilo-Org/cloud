import { type ToolPart } from '@kilocode/cloud-agent-sdk';

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

/**
 * Pure row projection for a tool part. The strings and badge rules are copied
 * verbatim from the tool-card bodies so the fixed row renders exactly what the
 * cards render today.
 */
export function getToolDisplay(part: ToolPart): ToolDisplay {
  const input = part.state.input;
  const status = part.state.status;

  switch (part.tool) {
    case 'read': {
      const filePath = typeof input.filePath === 'string' ? input.filePath : '';
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;

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
      const filePath = typeof input.filePath === 'string' ? input.filePath : '';
      return { title: 'edit', subtitle: filePath ? getFilename(filePath) : 'edit' };
    }
    case 'write': {
      const filePath = typeof input.filePath === 'string' ? input.filePath : '';
      return { title: 'write', subtitle: filePath ? getFilename(filePath) : 'write' };
    }
    case 'bash': {
      const command = typeof input.command === 'string' ? input.command : '';
      const description = typeof input.description === 'string' ? input.description : undefined;
      const subtitle = description ?? (command ? truncateText(command, 60) : 'bash');
      return { title: 'bash', subtitle };
    }
    case 'glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const output = status === 'completed' ? part.state.output : undefined;
      const matchCount = output ? countResultRows(output, 'glob') : undefined;
      const badge = matchCount !== undefined && matchCount > 0 ? `${matchCount} files` : undefined;
      return { title: 'glob', subtitle: pattern || 'glob', badge };
    }
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const include = typeof input.include === 'string' ? input.include : undefined;
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
      const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
      const path = typeof input.path === 'string' ? input.path : undefined;
      const resolvedPath = filePath ?? path ?? '';
      return { title: 'list', subtitle: resolvedPath ? getDirectoryName(resolvedPath) : 'list' };
    }
    case 'patch':
    case 'apply_patch': {
      const patchText = typeof input.patchText === 'string' ? input.patchText : '';
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
      const query = typeof input.query === 'string' ? input.query : undefined;
      const url = typeof input.url === 'string' ? input.url : undefined;
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
      const description = typeof input.description === 'string' ? input.description : undefined;
      const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
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
