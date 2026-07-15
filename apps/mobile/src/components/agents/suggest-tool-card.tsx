import { useAtomValue } from 'jotai';
import { Sparkles } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { useSessionManager } from '@/components/agents/session-provider';

import { resolveSuggestionPresentation } from './suggestion-card-state';
import { SuggestionCard } from './suggestion-card';
import { ToolCardShell } from './tool-card-shell';

export function SuggestToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const manager = useSessionManager();
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);
  const presentation = resolveSuggestionPresentation(
    part.state.status,
    part.callID,
    activeSuggestion
  );

  if (presentation === 'interactive' && activeSuggestion) {
    return (
      <SuggestionCard
        key={activeSuggestion.requestId}
        text={activeSuggestion.text}
        actions={activeSuggestion.actions}
        onAccept={async index => {
          await manager.acceptSuggestion(activeSuggestion.requestId, index);
        }}
        onDismiss={async () => {
          await manager.dismissSuggestion(activeSuggestion.requestId);
        }}
      />
    );
  }

  return (
    <ToolCardShell
      icon={Sparkles}
      title="Suggestion"
      subtitle={part.state.status === 'error' ? 'Suggestion dismissed' : 'Suggestion'}
      status={part.state.status}
    />
  );
}
