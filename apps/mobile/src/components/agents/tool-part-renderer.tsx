import { type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  ChildSessionSection,
  getTaskToolSessionId,
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
    const sessionId = getTaskToolSessionId(part);
    const childMessages = sessionId ? getChildMessages(sessionId) : [];

    return (
      <ChildSessionSection
        part={part}
        childMessages={childMessages}
        onOpenChildSession={onOpenChildSession}
        modelOptions={modelOptions}
      />
    );
  }

  switch (part.tool) {
    case 'read': {
      return <ReadToolCard part={part} />;
    }
    case 'edit': {
      return <EditToolCard part={part} />;
    }
    case 'write': {
      return <WriteToolCard part={part} />;
    }
    case 'bash': {
      return <BashToolCard part={part} />;
    }
    case 'glob': {
      return <GlobToolCard part={part} />;
    }
    case 'grep': {
      return <GrepToolCard part={part} />;
    }
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      return <WebSearchToolCard part={part} />;
    }
    case 'list': {
      return <ListToolCard part={part} />;
    }
    case 'patch':
    case 'apply_patch': {
      return <PatchToolCard part={part} />;
    }
    case 'todoread':
    case 'todowrite': {
      return <TodoToolCard part={part} />;
    }
    case 'task': {
      return <TaskToolCard part={part} />;
    }
    case 'suggest': {
      return <SuggestToolCard part={part} />;
    }
    default: {
      return <GenericToolCard part={part} />;
    }
  }
}
