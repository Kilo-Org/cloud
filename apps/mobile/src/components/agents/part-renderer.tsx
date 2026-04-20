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

type PartRendererProps = {
  part: Part;
  isStreaming?: boolean;
  getChildMessages?: (sessionId: string) => StoredMessage[];
};

export function PartRenderer({ part, isStreaming, getChildMessages }: Readonly<PartRendererProps>) {
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
