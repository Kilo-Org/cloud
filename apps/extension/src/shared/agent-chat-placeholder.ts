export interface AgentChatMessage {
  readonly body: string;
  readonly role: 'agent' | 'user';
}

export interface AgentPanelFooterState {
  readonly mode: 'dangerous' | 'safe';
  readonly model: string;
  readonly thinkingEffort: 'high' | 'low' | 'medium';
}

export interface AgentPanelState {
  readonly draft: string;
  readonly footer: AgentPanelFooterState;
  readonly messages: AgentChatMessage[];
}

export interface AgentFooterControlDisplay {
  readonly modeIcon: 'alert' | 'shield';
  readonly modeLabel: 'Danger' | 'Safe';
  readonly modelLabel: string;
  readonly thinkingLabel: 'High' | 'Low' | 'Med';
}

const modelLabels: Record<string, string> = {
  'Claude Opus 4': 'Opus 4',
  'Claude Sonnet 4': 'Sonnet 4',
  'GPT-5': 'GPT-5',
};

const getThinkingLabel = (
  thinkingEffort: AgentPanelFooterState['thinkingEffort']
): AgentFooterControlDisplay['thinkingLabel'] => {
  if (thinkingEffort === 'medium') {
    return 'Med';
  }

  if (thinkingEffort === 'low') {
    return 'Low';
  }

  return 'High';
};

export const getFooterControlDisplay = (
  footer: AgentPanelFooterState
): AgentFooterControlDisplay => ({
  modeIcon: footer.mode === 'safe' ? 'shield' : 'alert',
  modeLabel: footer.mode === 'safe' ? 'Safe' : 'Danger',
  modelLabel: modelLabels[footer.model] ?? footer.model,
  thinkingLabel: getThinkingLabel(footer.thinkingEffort),
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
