import { thinkingEffortLabel } from './kilo-api-client';

export interface AgentPanelFooterState {
  readonly mode: 'dangerous' | 'safe';
  readonly model: string;
  readonly thinkingEffort: string;
}

export interface AgentFooterControlDisplay {
  readonly modeDescription: 'Arbitrary webpage control' | 'Read only';
  readonly modeIcon: 'alert' | 'shield';
  readonly modeIconTone: 'danger' | 'safe';
  readonly modeLabel: 'Danger' | 'Safe';
  readonly modelLabel: string;
  readonly thinkingLabel: string;
}

const modelLabels: Record<string, string> = {
  'Claude Opus 4': 'Opus 4',
  'Claude Sonnet 4': 'Sonnet 4',
  'GPT-5': 'GPT-5',
};

export const defaultMode = 'safe';

export const getFooterControlDisplay = (
  footer: AgentPanelFooterState
): AgentFooterControlDisplay => ({
  modeDescription: footer.mode === 'safe' ? 'Read only' : 'Arbitrary webpage control',
  modeIcon: footer.mode === 'safe' ? 'shield' : 'alert',
  modeIconTone: footer.mode === 'safe' ? 'safe' : 'danger',
  modeLabel: footer.mode === 'safe' ? 'Safe' : 'Danger',
  modelLabel: modelLabels[footer.model] ?? footer.model,
  thinkingLabel: thinkingEffortLabel(footer.thinkingEffort),
});
