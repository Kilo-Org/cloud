'use client';
import React from 'react';

import { createContext, useContext, type ReactNode } from 'react';
import type { MessagePartState } from '@assistant-ui/react';
import type { ReadOnlyQuestionState } from '../QuestionToolStatus';
import type { OpenChildSession } from '../ChildSessionSection';
import type { StoredMessage } from '../types';
import type { CloudMessagePresentation, CloudPartPresentation } from './presentation-types';

export type CloudPresentationActions = {
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onOpenPreparationDetails?: (attemptId: string) => void;
  depth: number;
  presentationMode: 'live' | 'historical';
  questionState?: ReadOnlyQuestionState;
  renderChildTranscript: (
    messages: StoredMessage[],
    depth: number,
    getChildMessages?: (sessionId: string) => StoredMessage[]
  ) => ReactNode;
};

export const CloudPresentationContext = createContext<CloudPresentationActions | null>(null);

export function useCloudPresentationActions() {
  const actions = useContext(CloudPresentationContext);
  if (!actions) throw new Error('Cloud transcript requires presentation actions');
  return actions;
}

export const CloudMessagePresentationContext = createContext<CloudMessagePresentation | null>(null);

export function useCloudMessagePresentation(): CloudMessagePresentation {
  const presentation = useContext(CloudMessagePresentationContext);
  if (!presentation) throw new Error('Cloud message requires projected SDK metadata');
  return presentation;
}

export function findCloudPartPresentation(
  presentation: CloudMessagePresentation,
  part: MessagePartState
): CloudPartPresentation | undefined {
  return part.type === 'tool-call'
    ? presentation.parts.find(candidate => candidate.toolCallId === part.toolCallId)
    : presentation.parts.find(candidate => 'id' in part && candidate.id === part.id);
}
