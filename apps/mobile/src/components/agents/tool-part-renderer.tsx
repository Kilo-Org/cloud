import { type StoredMessage, type ToolPart } from 'cloud-agent-sdk';

import {
  ChildSessionSection,
  getTaskToolSessionId,
  type RenderPartFn,
} from './child-session-section';
import {
  BashToolCard,
  EditToolCard,
  GenericToolCard,
  GlobToolCard,
  GrepToolCard,
  ListToolCard,
  ReadToolCard,
  TaskToolCard,
  TodoToolCard,
  WebSearchToolCard,
  WriteToolCard,
} from './tool-cards';

type ToolPartRendererProps = {
  part: ToolPart;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  renderPart?: RenderPartFn;
};

export function ToolPartRenderer({
  part,
  getChildMessages,
  renderPart,
}: Readonly<ToolPartRendererProps>) {
  if (part.tool === 'plan_exit' || part.tool === 'plan_enter') {
    return null;
  }

  if (part.tool === 'task' && getChildMessages && renderPart) {
    const sessionId = getTaskToolSessionId(part);
    const childMessages = sessionId ? getChildMessages(sessionId) : [];

    return (
      <ChildSessionSection
        part={part}
        childMessages={childMessages}
        getChildMessages={getChildMessages}
        renderPart={renderPart}
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
    case 'todoread':
    case 'todowrite': {
      return <TodoToolCard part={part} />;
    }
    case 'task': {
      return <TaskToolCard part={part} />;
    }
    default: {
      return <GenericToolCard part={part} />;
    }
  }
}
