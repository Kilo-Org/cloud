'use client';

import React from 'react';
import { useAtomValue } from 'jotai';
import { Sparkles } from 'lucide-react';
import type { SessionManager } from '@kilocode/cloud-agent-sdk';

import { useOptionalManager } from './CloudAgentProvider';
import { SuggestionCard } from './SuggestionCard';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';

/**
 * Inline renderer for the `suggest` tool.
 *
 * While the tool is awaiting a user response, the interactive SuggestionCard
 * is rendered in-place using data from the activeSuggestion atom. This keeps
 * the card visually anchored to the tool call in the message stream and
 * leaves the text input free for the user to send messages in parallel.
 *
 * The card is only rendered when activeSuggestion.callId matches this tool
 * part's callID, so older pending suggest calls in the history don't repaint
 * with the newest suggestion's text/actions.
 *
 * Once the suggestion has been accepted or dismissed, a compact summary card
 * replaces the interactive UI.
 */
export function SuggestToolCard({ toolPart }: { toolPart: ToolPart }) {
  const manager = useOptionalManager();
  if (!manager) {
    return <SuggestSummaryCard toolPart={toolPart} />;
  }
  return <SuggestToolCardLive toolPart={toolPart} manager={manager} />;
}

function SuggestSummaryCard({ toolPart }: { toolPart: ToolPart }) {
  const { status } = toolPart.state;
  const subtitle = status === 'error' ? 'Suggestion dismissed' : 'Suggestion';
  return <ToolCardShell icon={Sparkles} title="Suggestion" subtitle={subtitle} status={status} />;
}

function SuggestToolCardLive({
  toolPart,
  manager,
}: {
  toolPart: ToolPart;
  manager: SessionManager;
}) {
  const { state } = toolPart;
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);

  const isPending = state.status === 'pending' || state.status === 'running';
  const isActiveForThisCall =
    activeSuggestion?.callId !== undefined && activeSuggestion.callId === toolPart.callID;

  if (isPending && activeSuggestion && isActiveForThisCall) {
    return (
      <SuggestionCard
        requestId={activeSuggestion.requestId}
        text={activeSuggestion.text}
        actions={activeSuggestion.actions}
      />
    );
  }

  return <SuggestSummaryCard toolPart={toolPart} />;
}
