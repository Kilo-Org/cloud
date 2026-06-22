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
