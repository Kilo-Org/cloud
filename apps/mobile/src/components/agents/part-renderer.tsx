import { type Part, type StoredMessage } from 'cloud-agent-sdk';

import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { MessageErrorBoundary } from './message-error-boundary';
import {
  isCompactionPart,
  isFilePart,
  isPartStreaming,
  isReasoningPart,
  isTextPart,
  isToolPart,
} from './part-types';
import { ReasoningPartRenderer } from './reasoning-part-renderer';
import { TextPartRenderer } from './text-part-renderer';
import { ToolPartRenderer } from './tool-part-renderer';
import { type OpenChildSession } from './child-session-section';

type PartRendererProps = {
  part: Part;
  isStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
  defaultReasoningExpanded?: boolean;
  onOpenChildSession?: OpenChildSession;
};

export function PartRenderer({
  part,
  isStreaming,
  getChildMessages,
  defaultReasoningExpanded,
  onOpenChildSession,
}: Readonly<PartRendererProps>) {
  if (isTextPart(part)) {
    return (
      <MessageErrorBoundary>
        <TextPartRenderer text={part.text} />
      </MessageErrorBoundary>
    );
  }
  if (isToolPart(part)) {
    return (
      <MessageErrorBoundary>
        <ToolPartRenderer
          part={part}
          getChildMessages={getChildMessages}
          renderPart={props => <PartRenderer {...props} />}
          onOpenChildSession={onOpenChildSession}
        />
      </MessageErrorBoundary>
    );
  }
  if (isReasoningPart(part)) {
    return (
      <MessageErrorBoundary>
        <ReasoningPartRenderer
          text={part.text}
          isStreaming={isStreaming && isPartStreaming(part)}
          defaultExpanded={defaultReasoningExpanded}
        />
      </MessageErrorBoundary>
    );
  }
  if (isFilePart(part)) {
    return (
      <MessageErrorBoundary>
        <FilePartRenderer part={part} />
      </MessageErrorBoundary>
    );
  }
  if (isCompactionPart(part)) {
    return <CompactionSeparator />;
  }
  // step-start, step-finish, patch, snapshot, agent, retry, subtask — not rendered
  return null;
}
