import { useAtomValue } from 'jotai';
import { Sparkles } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { useSessionManager } from '@/components/agents/session-provider';

import { FixedPartRow } from './fixed-part-row';
import { resolveSuggestionPresentation } from './suggestion-card-state';
import { SuggestionCard } from './suggestion-card';
import { getToolDisplay } from './tool-card-display';

export function SuggestToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const manager = useSessionManager();
  const { t } = useTranslation();
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

  const display = getToolDisplay(part);
  const label = display.subtitle ?? display.title;

  return (
    <FixedPartRow
      icon={Sparkles}
      label={label}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibility', {
        label,
        status: part.state.status,
      })}
    />
  );
}
