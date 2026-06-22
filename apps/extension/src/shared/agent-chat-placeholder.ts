import { thinkingEffortLabel } from './kilo-api-client';
import type { KiloGatewayModelOption } from './kilo-api-client';

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

const effortOptions = ['low', 'medium', 'high'] as const;

export const defaultMode = 'safe';
export const defaultThinkingEffort = 'medium';
export const fallbackDefaultModelId = 'Claude Sonnet 4';
export const defaultThinkingOption = 'default';

export const fallbackModelOptions: KiloGatewayModelOption[] = [
  {
    id: fallbackDefaultModelId,
    isPreferred: true,
    name: 'Claude Sonnet 4',
    variants: [...effortOptions],
  },
  {
    id: 'Claude Opus 4',
    isPreferred: true,
    name: 'Claude Opus 4',
    variants: [...effortOptions],
  },
  {
    id: 'GPT-5',
    isPreferred: true,
    name: 'GPT-5',
    variants: [...effortOptions],
  },
];

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
