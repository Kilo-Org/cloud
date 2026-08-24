import { type Part, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { CompactionSeparator } from './compaction-separator';
import { FilePartRenderer } from './file-part-renderer';
import { MessageErrorBoundary } from './message-error-boundary';
import { partRendersContent } from './message-visibility';
import {
  isCompactionPart,
  isFilePart,
  isPartStreaming,
  isPatchPart,
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
  modelOptions?: SessionModelOption[];
};

export function PartRenderer({
  part,
  isStreaming,
  getChildMessages,
  defaultReasoningExpanded,
  onOpenChildSession,
  modelOptions,
}: Readonly<PartRendererProps>) {
  if (!partRendersContent(part)) {
    return null;
  }
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
          modelOptions={modelOptions}
        />
      </MessageErrorBoundary>
    );
  }
  if (isReasoningPart(part)) {
    return (
      <MessageErrorBoundary>
        <ReasoningPartRenderer
          partId={part.id}
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
  // Standalone PatchPart (`type: 'patch'`) carries only file paths — no diff
  // text — so the diff engine cannot apply. The web renderer renders null for
  // it (apps/web/src/components/cloud-agent-next/PartRenderer.tsx:398-404).
  // If OpenCode ever ships diff text on the part, render it through `DiffLine`.
  if (isPatchPart(part)) {
    const fileCount = part.files.length;
    const summary = `Updated ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
    return (
      <MessageErrorBoundary>
        <View className="my-1 gap-1">
          <Text className="text-xs text-muted-foreground">{summary}</Text>
          {part.files.map(file => (
            <Text key={file} className="font-mono text-xs text-muted-foreground" numberOfLines={1}>
              {file}
            </Text>
          ))}
        </View>
      </MessageErrorBoundary>
    );
  }
  // step-start, step-finish, snapshot, agent, retry, subtask — not rendered
  return null;
}
