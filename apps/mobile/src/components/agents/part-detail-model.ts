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

/** Sheet header title plus the projection's translation provenance. */
export type PartDetailTitle = {
  /**
   * The already-localized label the header renders before `text` (`"read: "`
   * for a read tool), or null when the text stands alone. Never translated:
   * the projection's title is app copy or a raw tool id.
   */
  prefix: string | null;
  /**
   * The label the header translates. For a tool this is the row's non-empty
   * `display.subtitle`, so the row's cached translation is the header's and the
   * sheet opens already translated; an empty subtitle falls back to the tool
   * title rather than rendering a blank header.
   */
  text: string;
  translatable: boolean;
};

/**
 * Sheet header title for a part. Tools follow the same display projection the
 * fixed row uses so the title updates live with the part. Reasoning shows the
 * stream state; anything else is an unreachable fallback.
 *
 * `translatable` carries the projection's provenance: the text is the row's
 * projected label, so a row the projection marks non-translatable (an
 * already-localized fallback label or a raw tool id) must not be sent to the
 * gateway either. The empty-subtitle fallback is the tool title too, so it is
 * never translated.
 */
export function getPartDetailTitle(part: Part): PartDetailTitle {
  if (isReasoningPart(part)) {
    return {
      prefix: null,
      text: isPartStreaming(part)
        ? i18n.t('agentChat.partDetail.thinking')
        : i18n.t('agentChat.partDetail.thought'),
      translatable: false,
    };
  }
  if (isToolPart(part)) {
    const display = getToolDisplay(part);
    // A bash/task call whose `description` is the empty string projects an
    // empty subtitle, and an empty header tells the user nothing about the
    // call; fall back to the tool title the row's prefix would have shown.
    const hasSubtitle = Boolean(display.subtitle);
    return {
      prefix: display.subtitle ? display.title : null,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty subtitle must fall back to the tool title; ?? keeps the blank header
      text: display.subtitle || display.title,
      translatable: hasSubtitle && display.translatable,
    };
  }
  return { prefix: null, text: i18n.t('common.details'), translatable: false };
}

/**
 * Auto-follow is only for a streaming reasoning part: the "Thinking" sheet
 * follows the growing text. Tool parts and finished parts keep the static
 * top-anchored sheet.
 */
export function shouldAutoFollowPartDetail(part: Part | null): boolean {
  return part !== null && isReasoningPart(part) && isPartStreaming(part);
}
