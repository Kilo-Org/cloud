/**
 * Types for opencode's message, part and event shapes.
 *
 * The generated half lives in `./opencode.gen`, which cannot be regenerated in
 * this repository: neither the opencode OpenAPI specification nor the generator
 * is checked in. This module re-exports those types and owns the hand-written
 * Kilo extensions on top of them, re-declaring every generated type whose shape
 * the extensions change so they stay visible at each embedded position.
 */
export type * from './opencode.gen';

import type * as generated from './opencode.gen';

export type EditorContext = {
  visibleFiles?: Array<string>;
  openTabs?: Array<string>;
  activeFile?: string;
  shell?: string;
  timezone?: string;
};

export type UserMessage = generated.UserMessage & {
  /** Kilo extension: marks a client-materialised row not yet confirmed by the server. */
  synthetic?: boolean;
  /** Kilo extension: server time a client-materialised row was queued; orders it until the server's own row replaces it. */
  queuedAt?: number;
  /** Kilo extension: the client's editor state carried on the user message. */
  editorContext?: EditorContext;
};

export type Message = UserMessage | generated.AssistantMessage;

export type EventMessageUpdated = Omit<generated.EventMessageUpdated, 'properties'> & {
  properties: Omit<generated.EventMessageUpdated['properties'], 'info'> & { info: Message };
};

export type FilePart = generated.FilePart & {
  /** Kilo extension: marks a local placeholder part to drop when the authoritative file part arrives. */
  synthetic?: boolean;
};

export type ToolStateCompleted = Omit<generated.ToolStateCompleted, 'attachments'> & {
  attachments?: Array<FilePart>;
};

export type ToolState =
  Exclude<generated.ToolState, generated.ToolStateCompleted> | ToolStateCompleted;

export type ToolPart = Omit<generated.ToolPart, 'state'> & { state: ToolState };

export type Part =
  | Exclude<generated.Part, generated.FilePart | generated.ToolPart>
  | FilePart
  | ToolPart;

export type EventMessagePartUpdated = Omit<generated.EventMessagePartUpdated, 'properties'> & {
  properties: Omit<generated.EventMessagePartUpdated['properties'], 'part'> & { part: Part };
};
