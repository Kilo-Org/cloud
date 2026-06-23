export interface KiloGatewayChatMessage {
  readonly content?: string | null;
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  readonly tool_call_id?: string;
  readonly tool_calls?: KiloGatewayChatToolCall[];
}

export interface KiloGatewayChatToolCall {
  readonly function: {
    readonly arguments: string;
    readonly name: 'eval';
  };
  readonly id: string;
  readonly type: 'function';
}

export interface KiloGatewayToolDefinition {
  readonly function: {
    readonly description: string;
    readonly name: 'eval';
    readonly parameters: Record<string, unknown>;
  };
  readonly type: 'function';
}

export interface KiloGatewayEvalToolCall {
  readonly code: string;
  readonly id: string;
  readonly name: 'eval';
}

export interface KiloGatewayChatCompletion {
  readonly content?: string;
  readonly reasoning?: string;
  readonly toolCalls: KiloGatewayEvalToolCall[];
}
