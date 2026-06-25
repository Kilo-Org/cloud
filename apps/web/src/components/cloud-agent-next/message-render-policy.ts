import type { ReactNode } from 'react';
import type { ToolPart } from './types';

export type ToolPartRenderDecision = { handled: false } | { handled: true; node: ReactNode };

export type MessageRenderPolicy = Readonly<{
  transformAssistantText?: (text: string) => string;
  renderToolPart?: (part: ToolPart) => ToolPartRenderDecision;
}>;
