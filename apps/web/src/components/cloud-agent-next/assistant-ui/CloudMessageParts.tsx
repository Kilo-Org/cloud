'use client';
import React from 'react';

import {
  MessagePrimitive,
  type TextMessagePartProps,
  type ReasoningMessagePartProps,
  type DataMessagePartProps,
  type ToolCallMessagePartProps,
  type EnrichedPartState,
} from '@assistant-ui/react';
import {
  TextPartRenderer,
  ReasoningPartRenderer,
  FilePartRenderer,
  SubtaskPartRenderer,
  UnknownPartRenderer,
} from '../part-content';
import { MessageErrorBoundary } from '../MessageErrorBoundary';
import { isPartStreaming } from '../types';
import { CloudToolRenderer } from './CloudToolRenderer';
import {
  useCloudMessagePresentation,
  findCloudPartPresentation,
} from './cloud-presentation-context';

type CloudPartProps = TextMessagePartProps | ReasoningMessagePartProps | DataMessagePartProps;

function CloudPartContent({ nativePart }: { nativePart: CloudPartProps }) {
  const presentation = useCloudMessagePresentation();
  const part = findCloudPartPresentation(presentation, nativePart)?.source;
  if (!part) return <p className="text-muted-foreground px-2 text-xs">Content is unavailable.</p>;
  const streaming = presentation.isStreaming && isPartStreaming(part);
  switch (part.type) {
    case 'text':
      return <TextPartRenderer text={part.text} isStreaming={streaming} />;
    case 'reasoning':
      return <ReasoningPartRenderer part={part} isStreaming={streaming} />;
    case 'file':
      return <FilePartRenderer part={part} />;
    case 'subtask':
      return <SubtaskPartRenderer part={part} />;
    case 'step-start':
    case 'step-finish':
    case 'patch':
      return null;
    default:
      return <UnknownPartRenderer part={part} />;
  }
}

function CloudPart(nativePart: CloudPartProps) {
  return (
    <MessageErrorBoundary
      fallback={<p className="text-destructive text-xs">Failed to render content</p>}
    >
      <CloudPartContent nativePart={nativePart} />
    </MessageErrorBoundary>
  );
}
function CloudTool(nativePart: ToolCallMessagePartProps) {
  const presentation = useCloudMessagePresentation();
  const part = findCloudPartPresentation(presentation, nativePart)?.source;
  if (part?.type !== 'tool') return null;
  return (
    <MessageErrorBoundary
      fallback={<p className="text-destructive text-xs">Failed to render tool</p>}
    >
      <CloudToolRenderer part={part} />
    </MessageErrorBoundary>
  );
}
const components = {
  Text: CloudPart,
  Reasoning: CloudPart,
  data: { Fallback: CloudPart },
  tools: { Override: CloudTool },
  Empty: () => null,
};

function renderCloudPart({ part }: { part: EnrichedPartState }) {
  switch (part.type) {
    case 'tool-call':
      return <CloudTool {...part} />;
    case 'text':
      // The public callback synthesizes an identity-free empty running text
      // when the assistant has no SDK parts. Cloud owns its waiting indicator.
      if (!part.id && part.text === '') return null;
      return <CloudPart {...part} />;
    case 'reasoning':
    case 'data':
      return <CloudPart {...part} />;
    default:
      return null;
  }
}

export function CloudMessageParts() {
  return <MessagePrimitive.Parts>{renderCloudPart}</MessagePrimitive.Parts>;
}

export function CloudMessagePartByIndex({ index }: { index: number }) {
  return <MessagePrimitive.PartByIndex index={index} components={components} />;
}
