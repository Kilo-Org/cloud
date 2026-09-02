import { useAtomValue } from 'jotai';
import { View } from 'react-native';
import { Sparkles } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { useTranslation } from 'react-i18next';

import { useSessionManager } from '@/components/agents/session-provider';
import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from './fixed-part-row';
import { MonoScrollBlock } from './mono-scroll-block';
import { useOpenPartDetail } from './open-part-detail-context';
import { resolveSuggestionPresentation, suggestionToolInputSchema } from './suggestion-card-state';
import { getToolDisplay, toolPartHasDetails } from './tool-card-display';
import { GenericToolCardBody } from './tool-cards/generic-tool-card';

function useActiveToolSuggestion(part: ToolPart) {
  const manager = useSessionManager();
  const activeSuggestion = useAtomValue(manager.atoms.activeSuggestion);
  const matches =
    resolveSuggestionPresentation(part.state.status, part.callID, activeSuggestion) ===
    'interactive';
  return matches ? activeSuggestion : null;
}

export function SuggestToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const suggestion = useActiveToolSuggestion(part);
  const { t } = useTranslation();
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const label = suggestion?.text ?? display.subtitle ?? display.title;
  const hasDetails = suggestion !== null || toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Sparkles}
      label={label}
      status={part.state.status}
      accessibilityLabel={t('agentChat.toolCard.accessibility', {
        label,
        status: part.state.status,
      })}
      onPress={
        hasDetails && openPartDetail
          ? () => {
              openPartDetail(part.id);
            }
          : undefined
      }
    />
  );
}

export function SuggestToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const suggestion = useActiveToolSuggestion(part);
  const input = suggestionToolInputSchema.safeParse(part.state.input);
  const details =
    suggestion ??
    (input.success ? { text: input.data.suggest, actions: input.data.actions } : null);
  if (!details) {
    return <GenericToolCardBody part={part} />;
  }

  return (
    <View className="gap-3">
      <SelectableText className="text-sm text-foreground">{details.text}</SelectableText>
      {details.actions.map((action, index) => (
        <View key={`${action.label}-${index}`} className="gap-1 rounded-lg bg-secondary p-3">
          <SelectableText className="text-sm font-medium text-foreground">
            {action.label}
          </SelectableText>
          {action.description ? (
            <SelectableText className="text-sm text-muted-foreground">
              {action.description}
            </SelectableText>
          ) : null}
          <MonoScrollBlock content={action.prompt} textClassName="text-foreground" />
        </View>
      ))}
      {part.state.status === 'completed' && part.state.output ? (
        <MonoScrollBlock content={part.state.output} textClassName="text-foreground" />
      ) : null}
      {part.state.status === 'error' ? (
        <SelectableText className="text-xs text-destructive">{part.state.error}</SelectableText>
      ) : null}
    </View>
  );
}
