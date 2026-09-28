import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { type ReactNode } from 'react';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  LiveChildSessionSection,
  type OpenChildSession,
  type RenderPartFn,
} from './child-session-section';
import {
  BashToolCard,
  EditToolCard,
  GenericToolCard,
  GlobToolCard,
  GrepToolCard,
  ListToolCard,
  PatchToolCard,
  ReadToolCard,
  TaskToolCard,
  TodoToolCard,
  WebSearchToolCard,
  WriteToolCard,
} from './tool-cards';
import { SuggestToolCard } from './suggest-tool-card';
import { ToolSummaryTranslationScope } from './tool-summary-translation-scope';

type ToolPartRendererProps = {
  part: ToolPart;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  renderPart?: RenderPartFn;
  onOpenChildSession?: OpenChildSession;
  modelOptions?: SessionModelOption[];
};

export function ToolPartRenderer({
  part,
  getChildMessages,
  renderPart,
  onOpenChildSession,
  modelOptions,
}: Readonly<ToolPartRendererProps>) {
  if (part.tool === 'plan_exit' || part.tool === 'plan_enter') {
    return null;
  }

  if (part.tool === 'task' && getChildMessages && renderPart && onOpenChildSession) {
    // `LiveChildSessionSection` subscribes to the child transcript itself, so
    // the memoized `MessageBubble` above can keep one prop identity across
    // streaming publishes while the card's activity label still updates.
    return (
      <LiveChildSessionSection
        part={part}
        getChildMessages={getChildMessages}
        onOpenChildSession={onOpenChildSession}
        modelOptions={modelOptions}
      />
    );
  }

  let card: ReactNode = null;
  switch (part.tool) {
    case 'read': {
      card = <ReadToolCard part={part} />;
      break;
    }
    case 'edit': {
      card = <EditToolCard part={part} />;
      break;
    }
    case 'write': {
      card = <WriteToolCard part={part} />;
      break;
    }
    case 'bash': {
      card = <BashToolCard part={part} />;
      break;
    }
    case 'glob': {
      card = <GlobToolCard part={part} />;
      break;
    }
    case 'grep': {
      card = <GrepToolCard part={part} />;
      break;
    }
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      card = <WebSearchToolCard part={part} />;
      break;
    }
    case 'list': {
      card = <ListToolCard part={part} />;
      break;
    }
    case 'patch':
    case 'apply_patch': {
      card = <PatchToolCard part={part} />;
      break;
    }
    case 'todoread':
    case 'todowrite': {
      card = <TodoToolCard part={part} />;
      break;
    }
    case 'task': {
      card = <TaskToolCard part={part} />;
      break;
    }
    case 'suggest': {
      card = <SuggestToolCard part={part} />;
      break;
    }
    default: {
      card = <GenericToolCard part={part} />;
    }
  }

  return <ToolSummaryTranslationScope itemId={part.id}>{card}</ToolSummaryTranslationScope>;
}
