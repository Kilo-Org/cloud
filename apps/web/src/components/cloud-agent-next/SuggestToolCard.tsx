'use client';

import { useAtomValue } from 'jotai';
import { Sparkles } from 'lucide-react';

import { useManager } from './CloudAgentProvider';
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
 * Once the suggestion has been accepted or dismissed, a compact summary card
 * replaces the interactive UI.
 */
export function SuggestToolCard({ toolPart }: { toolPart: ToolPart }) {
  const { state } = toolPart;
  const manager = useManager();
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);

  const isPending = state.status === 'pending' || state.status === 'running';

  if (isPending && activeSuggestion) {
    return (
      <SuggestionCard
        requestId={activeSuggestion.requestId}
        text={activeSuggestion.text}
        actions={activeSuggestion.actions}
      />
    );
  }

  // Resolved states (or pending without a loaded activeSuggestion) — compact summary.
  const subtitle = state.status === 'error' ? 'Suggestion dismissed' : 'Suggestion';
  return (
    <ToolCardShell icon={Sparkles} title="Suggestion" subtitle={subtitle} status={state.status} />
  );
}
