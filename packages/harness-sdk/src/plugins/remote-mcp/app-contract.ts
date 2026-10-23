import type { Implementation } from '@modelcontextprotocol/sdk/types.js';
import { type RemoteMcpCallResult } from './client.js';

/**
 * The contract between the bridge and the surface that draws it.
 *
 * The surface owns a WebView and the React around it; it hands the bridge one
 * transport, receives the text the view sent, and drives the view's lifecycle.
 * It names no protocol method, so this is the whole of what it must implement.
 */

/**
 * A message the bridge and the view exchange, as the surface carries it.
 *
 * The surface moves the text and does not read it: a `send` writes the message
 * into the sandbox as JSON, and the text that arrives from it is handed back
 * through `receive`. The shape is deliberately opaque so no surface
 * re-implements the protocol.
 */
interface RemoteMcpAppTransport {
  /** Sends one bridge message to the view, as a JSON string. */
  send(message: string): void;
}

/** How big the view currently draws itself, which is what the surface sizes to. */
interface RemoteMcpAppSize {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/**
 * What the view is told about where it runs: the person's own theme and
 * language, so a view that follows them looks like the app around it, and the
 * box the surface drew, so it lays itself out once instead of after a resize.
 */
interface RemoteMcpAppContext {
  readonly theme?: 'light' | 'dark';
  readonly locale?: string;
  readonly timeZone?: string;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

interface RemoteMcpAppOptions {
  /**
   * The tools this server was discovered to offer, by the server's own names —
   * which are the names a view calls them by. A name outside this set is not
   * forwarded.
   */
  readonly tools: readonly string[];
  readonly context?: RemoteMcpAppContext;
  /** What the view is told the host is. */
  readonly host?: Implementation;
  /** Opens a link the view asked for. The caller validates the scheme. */
  readonly openLink?: (uri: string) => void;
}

/**
 * One view, as the surface drives it: connect when the sandbox is ready, hand
 * it the call when it has initialized, and close it when the row goes away.
 */
interface RemoteMcpApp {
  /** Starts the bridge over a transport that writes into the sandbox. */
  readonly connect: (transport: RemoteMcpAppTransport) => Promise<void>;
  /** Hands the bridge one message the view sent, as the text it sent. */
  readonly receive: (text: string) => void;
  /** The call's complete arguments, sent once the view has initialized. */
  readonly input: (arguments_: Readonly<Record<string, unknown>>) => Promise<void>;
  /** The call's answer, sent after `input`. */
  readonly result: (answered: RemoteMcpAppResult) => Promise<void>;
  /** Told when the view has completed its initialization. */
  readonly onInitialized: (listener: () => void) => () => void;
  /** Told every time the view reports a size. */
  readonly onSizeChanged: (listener: (size: RemoteMcpAppSize) => void) => () => void;
  /** Tears the view down and closes the bridge. */
  readonly close: () => Promise<void>;
}

/**
 * What a surface holds for one answered call: the server's own content, which
 * is what a view renders. The text the model read is the surface's to keep, not
 * the bridge's to need.
 */
interface RemoteMcpAppResult {
  readonly content: RemoteMcpCallResult['content'];
  readonly structuredContent: RemoteMcpCallResult['structuredContent'];
}

export type {
  RemoteMcpApp,
  RemoteMcpAppContext,
  RemoteMcpAppOptions,
  RemoteMcpAppResult,
  RemoteMcpAppSize,
  RemoteMcpAppTransport,
};
