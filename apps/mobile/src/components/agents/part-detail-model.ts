import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';

import { i18n } from '@/i18n';

import { isPartStreaming, isReasoningPart, isToolPart } from './part-types';
import { isMarkdownPath, resolveReadCodeBody } from './read-tool-markdown';
import { getToolFileAttachments, getToolImageAttachments } from './tool-card-attachments';
import { getToolDisplay } from './tool-card-display';
import { buildResultRowsModel, buildTodoListModel } from './tool-list-model';

const stringSchema = z.string();

export function shouldCenterPartDetail(
  part: Part | null,
  hasCachedAttachment: boolean,
  imageFailed = false
): boolean {
  if (part === null) {
    return true;
  }
  if (!isToolPart(part)) {
    return false;
  }

  const hasImages = getToolImageAttachments(part).length > 0;
  const hasFiles = getToolFileAttachments(part).length > 0;
  const hasAttachments = hasImages || hasFiles;
  if (hasCachedAttachment && (hasFiles || (hasImages && !imageFailed))) {
    return false;
  }

  const { state, tool } = part;
  const { input } = state;
  const output = state.status === 'completed' ? state.output : '';
  const hasState = hasAttachments || (state.status === 'error' && state.error.length > 0);

  switch (tool) {
    case 'read': {
      const body = resolveReadCodeBody(part);
      const filePath = stringSchema.safeParse(input.filePath).data ?? '';
      if (body && (!hasImages || isMarkdownPath(filePath))) {
        return body.text === '';
      }
      return hasState && (hasImages || !output);
    }
    case 'write': {
      const content = stringSchema.safeParse(input.content).data ?? '';
      return content === '' && (state.status === 'completed' || state.status === 'error');
    }
    case 'todoread':
    case 'todowrite': {
      const model = buildTodoListModel(part);
      return model ? model.tasks.length === 0 : hasState && !output;
    }
    case 'glob':
    case 'grep':
    case 'list': {
      const model = output ? buildResultRowsModel(output, tool) : undefined;
      return model
        ? model.rows.length === 0 && (Boolean(model.caption) || model.truncated || hasAttachments)
        : hasState;
    }
    case 'edit': {
      return (
        hasState &&
        !stringSchema.safeParse(input.oldString).data &&
        !stringSchema.safeParse(input.newString).data
      );
    }
    case 'bash': {
      return hasState && !stringSchema.safeParse(input.command).data && !output;
    }
    case 'task':
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      return hasState && !output;
    }
    case 'suggest': {
      return false;
    }
    default: {
      return hasState && Object.keys(input).length === 0 && !output;
    }
  }
}

/**
 * Resolve a part by id from a surface's live messages. The sheet host calls
 * this on every render so an open sheet tracks the part as it streams.
 */
export function findPartById(messages: readonly StoredMessage[], partId: string): Part | null {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.id === partId) {
        return part;
      }
    }
  }
  return null;
}

/**
 * Sheet header title for a part. Tools follow the same display projection the
 * fixed row uses so the title updates live with the part. Reasoning shows the
 * stream state; anything else is an unreachable fallback.
 */
export function getPartDetailTitle(part: Part): string {
  if (isReasoningPart(part)) {
    return isPartStreaming(part)
      ? i18n.t('agentChat.partDetail.thinking')
      : i18n.t('agentChat.partDetail.thought');
  }
  if (isToolPart(part)) {
    const display = getToolDisplay(part);
    return display.subtitle ? `${display.title}: ${display.subtitle}` : display.title;
  }
  return i18n.t(
    // i18n-dup-ok: 'common.details' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
    'common.details'
  );
}

/**
 * Auto-follow is only for a streaming reasoning part: the "Thinking" sheet
 * follows the growing text. Tool parts and finished parts keep the static
 * top-anchored sheet.
 */
export function shouldAutoFollowPartDetail(part: Part | null): boolean {
  return part !== null && isReasoningPart(part) && isPartStreaming(part);
}
