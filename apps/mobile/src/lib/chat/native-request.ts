import { type ModelRequest } from '@kilocode/harness-sdk';

import { type NativeTool, nativeTools } from './native-tool-schema';

/**
 * What a model gets in place of an image over its per-request limit. The
 * newest images are the ones sent, and the model is told an older one was there.
 */
export const IMAGE_NOT_SENT =
  '[An image was shared here. This model reads only the most recent images, so it is not sent.]';

/** A base64 image and its media type, as the harness prompt carries it. */
type NativeImage = { readonly media: string; readonly data: string };

export type NativeToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

/**
 * One transcript entry. The text roles reach every provider. The tool roles
 * reach only a provider that runs tools, and each output names its call. The
 * images reach only a provider that reads them.
 */
type NativeMessage =
  | {
      readonly role: 'user' | 'assistant';
      readonly text: string;
      /** Present only for a model that reads images. */
      readonly images?: readonly NativeImage[];
    }
  | { readonly role: 'toolCalls'; readonly calls: readonly NativeToolCall[] }
  | {
      readonly role: 'toolOutput';
      readonly callId: string;
      readonly name: string;
      readonly text: string;
    };

/** What the Apple and Android inference modules receive for one generation. */
export type NativeRequest = {
  readonly id: string;
  readonly system: string;
  readonly messages: readonly NativeMessage[];
  readonly maxTokens: number;
  readonly tools?: readonly NativeTool[];
};

export type NativeToolResult = { readonly callId: string; readonly body: string };

type RequestOptions = {
  readonly id: string;
  /** The provider's output ceiling; zero when it reports none. */
  readonly ceiling: number;
  /** Whether the provider runs the tool loop. */
  readonly tools: boolean;
  /** Whether the provider reads image parts. */
  readonly images: boolean;
  /** The most images one request can carry. Absent means no fixed limit. */
  readonly maxImages?: number;
};

/**
 * The transcript a system model reads. Reasoning never reaches it. Images reach
 * a model that reads them, and the newest take the model's image limit. Tool
 * calls and results reach only a model that runs tools, and then only in pairs:
 * a call with no result, or a result with no call, is left out.
 */
export function nativeRequest(request: ModelRequest, options: RequestOptions): NativeRequest {
  const { id, ceiling, tools, images: readsImages, maxImages } = options;
  const answered = new Set(
    request.prompt.messages.flatMap(message =>
      message.parts.flatMap(part => (part.kind === 'toolResult' ? [part.callId] : []))
    )
  );
  // The name of each call by its id, for the output that answers it.
  const names = new Map<string, string>();
  if (tools) {
    for (const message of request.prompt.messages) {
      for (const part of message.parts) {
        if (part.kind === 'toolCall' && answered.has(part.callId)) {
          names.set(part.callId, part.name);
        }
      }
    }
  }
  // Newest first, so the newest images take the request's image limit; an older
  // one that does not fit becomes a note in place of the image.
  const offered = readsImages
    ? request.prompt.messages.flatMap(message =>
        message.role === 'user'
          ? message.parts.flatMap(part => (part.kind === 'image' ? [part] : []))
          : []
      )
    : [];
  const sent =
    maxImages === undefined
      ? new Set(offered)
      : new Set(offered.slice(Math.max(0, offered.length - maxImages)));

  const messages: NativeMessage[] = [];
  for (const message of request.prompt.messages) {
    if (tools) {
      for (const part of message.parts) {
        const name = part.kind === 'toolResult' ? names.get(part.callId) : undefined;
        if (part.kind === 'toolResult' && name !== undefined) {
          messages.push({ role: 'toolOutput', callId: part.callId, name, text: part.body });
        }
      }
    }
    const texts: string[] = [];
    const images: NativeImage[] = [];
    for (const part of message.parts) {
      if (part.kind === 'text') {
        texts.push(part.text);
      } else if (part.kind === 'image' && readsImages && message.role === 'user') {
        if (sent.has(part)) {
          images.push({ media: part.media, data: part.data });
        } else {
          texts.push(IMAGE_NOT_SENT);
        }
      }
    }
    const text = texts.join('\n\n');
    if (images.length > 0) {
      // An image-only question is still a question.
      messages.push({ role: message.role, text, images });
    } else if (text !== '') {
      messages.push({ role: message.role, text });
    }
    const calls = (tools ? message.parts : []).flatMap(part =>
      part.kind === 'toolCall' && answered.has(part.callId)
        ? [{ id: part.callId, name: part.name, arguments: part.arguments }]
        : []
    );
    if (calls.length > 0) {
      messages.push({ role: 'toolCalls', calls });
    }
  }
  const toolSchemas = tools && request.tools !== undefined ? nativeTools(request.tools) : [];
  return {
    id,
    system: request.prompt.system.map(block => block.text).join('\n\n'),
    messages,
    maxTokens: ceiling > 0 ? Math.min(request.maxTokens, ceiling) : request.maxTokens,
    ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
  };
}

/** The results when the request ends on them alone: the harness answering a tool round. */
export function resultsOf(request: ModelRequest): NativeToolResult[] | undefined {
  const last = request.prompt.messages.at(-1);
  const results = (last?.parts ?? []).flatMap(part =>
    part.kind === 'toolResult' ? [{ callId: part.callId, body: part.body }] : []
  );
  return last?.role === 'user' && results.length > 0 && results.length === last.parts.length
    ? results
    : undefined;
}
