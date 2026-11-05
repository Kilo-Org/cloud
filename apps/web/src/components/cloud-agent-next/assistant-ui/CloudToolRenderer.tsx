'use client';
import React from 'react';

import { ChildSessionSection, getTaskToolSessionId } from '../ChildSessionSection';
import { QuestionToolStatus } from '../QuestionToolStatus';
import { ToolPartRenderer } from '../part-content';
import type { ToolPart } from '../types';
import { useCloudPresentationActions } from './cloud-presentation-context';

export function CloudToolRenderer({ part }: { part: ToolPart }) {
  const actions = useCloudPresentationActions();
  if (part.tool === 'question')
    return (
      <QuestionToolStatus
        toolPart={part}
        presentation={actions.presentationMode}
        readOnlyState={actions.questionState}
      />
    );
  if (part.tool === 'task' && part.state.status !== 'error') {
    const sessionId = getTaskToolSessionId(part);
    const messages = sessionId ? (actions.getChildMessages?.(sessionId) ?? []) : [];
    return (
      <ChildSessionSection
        taskToolPart={part}
        sessionId={sessionId}
        childMessages={messages}
        getChildMessages={actions.getChildMessages}
        onOpenChildSession={actions.onOpenChildSession}
        depth={actions.depth}
        renderChildTranscript={actions.renderChildTranscript}
      />
    );
  }
  return <ToolPartRenderer part={part} />;
}
