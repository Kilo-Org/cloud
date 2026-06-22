import { thinkingEffortLabel } from './kilo-api-client';

export interface AgentChatMessage {
  readonly body: string;
  readonly role: 'agent' | 'user';
}

export interface AgentPanelFooterState {
  readonly mode: 'dangerous' | 'safe';
  readonly model: string;
  readonly thinkingEffort: string;
}

export interface AgentPanelState {
  readonly draft: string;
  readonly footer: AgentPanelFooterState;
  readonly messages: AgentChatMessage[];
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

export const getDefaultAgentPanelState = (): AgentPanelState => ({
  draft: '',
  footer: {
    mode: 'safe',
    model: 'Claude Sonnet 4',
    thinkingEffort: 'medium',
  },
  messages: [
    {
      body: 'I can inspect the selected tab, read page structure, and prepare browser actions.',
      role: 'agent',
    },
    {
      body: 'Check this page and tell me what Kilo can do here.',
      role: 'user',
    },
    {
      body: 'Ready. Safe mode is on, so I will only read page context until you change modes.',
      role: 'agent',
    },
  ],
});
