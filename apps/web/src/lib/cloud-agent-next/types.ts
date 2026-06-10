export type SendMessagePayload =
  | {
      type: 'prompt';
      prompt: string;
      mode: string;
      model: string;
      variant?: string;
    }
  | {
      type: 'command';
      command: string;
      arguments: string;
    };
