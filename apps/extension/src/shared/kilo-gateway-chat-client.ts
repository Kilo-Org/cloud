export type KiloGatewayToolName =
  | 'eval'
  | 'find_in_page'
  | 'get_element_details'
  | 'get_page_snapshot'
  | 'get_viewport_screenshot';

export type KiloGatewayChatContentPart =
  | {
      readonly text: string;
      readonly type: 'text';
    }
  | {
      readonly image_url: {
        readonly url: string;
      };
      readonly type: 'image_url';
    };

export interface KiloGatewayChatMessage {
  readonly content?: KiloGatewayChatContentPart[] | string | null;
  readonly reasoning_details?: readonly unknown[];
  readonly role: 'assistant' | 'system' | 'tool' | 'user';
  readonly tool_call_id?: string;
  readonly tool_calls?: KiloGatewayChatToolCall[];
}

export interface KiloGatewayChatToolCall {
  readonly function: {
    readonly arguments: string;
    readonly name: KiloGatewayToolName;
  };
  readonly id: string;
  readonly type: 'function';
}

export interface KiloGatewayToolDefinition {
  readonly function: {
    readonly description: string;
    readonly name: KiloGatewayToolName;
    readonly parameters: Record<string, unknown>;
  };
  readonly type: 'function';
}

export interface KiloGatewayToolCallRequest {
  readonly arguments: Record<string, unknown>;
  readonly id: string;
  readonly name: KiloGatewayToolName;
}

export interface KiloGatewayChatCompletion {
  readonly content?: string;
  readonly reasoning?: string;
  readonly reasoningDetails?: readonly unknown[];
  readonly toolCalls: KiloGatewayToolCallRequest[];
}
