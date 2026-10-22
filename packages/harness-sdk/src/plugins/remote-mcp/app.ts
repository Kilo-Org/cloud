import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolRequest,
  type CallToolResult,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Effect } from 'effect';
import type {
  RemoteMcpApp,
  RemoteMcpAppContext,
  RemoteMcpAppOptions,
  RemoteMcpAppResult,
  RemoteMcpAppTransport,
} from './app-contract.js';
import { type RemoteMcpClient, remoteMcpClient } from './client.js';
import { type RemoteMcpClientDeps } from './deps.js';
import { explain, type RemoteMcpServer } from './server.js';

/**
 * The host half of one MCP Apps view.
 *
 * A server may attach a `ui://` resource to a tool; the resource is HTML that
 * runs on the person's device with the call in its hands and can call that
 * server's tools back. The bridge between the two is the official `AppBridge`,
 * from the package the plugin reads a tool's view uri with, so the protocol —
 * initialization, tool input and result, size changes, link opens, tool calls
 * — is the specification's and not this file's.
 *
 * This file holds the semantics a view is entitled to and the surface that
 * draws it cannot be trusted with:
 *
 * - A view's tool call reaches the server through the same client a model's
 *   call uses, so the credential accessor, the deadline and the failure
 *   classification are the same, and a call that did not reach the server is
 *   reported to the surface exactly as a model's call would be.
 * - A view may only call the tools of its own server, by the names that server
 *   was discovered to offer. Anything else is refused before a request exists.
 * - Nothing the view asks for beyond a tool call, a link open or a log line is
 *   answered: those requests get the protocol's method-not-found rather than
 *   an invented capability.
 *
 * The surface draws the WebView, sandboxes it, and carries bytes in and out as
 * text. It never names a method here.
 */

/**
 * A host that answers tools, opens links and accepts logs. Sampling,
 * model-context updates, messages, downloads and display-mode changes are not
 * offered, so a view does not show them.
 */
const HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  logging: {},
};

/** How long a closing surface waits for the view's own teardown. */
const TEARDOWN_TIMEOUT_MS = 1000;

/** The call's answer, as the protocol defines it, for the view. */
const callToolResultOf = (answered: RemoteMcpAppResult): CallToolResult =>
  answered.structuredContent === undefined
    ? { content: [...answered.content] }
    : { content: [...answered.content], structuredContent: answered.structuredContent };

/** What the view is told about where it runs. */
const hostContextOf = (context: RemoteMcpAppContext | undefined): McpUiHostContext => ({
  displayMode: 'inline',
  availableDisplayModes: ['inline'],
  platform: 'mobile',
  deviceCapabilities: { touch: true, hover: false },
  ...(context?.theme === undefined ? {} : { theme: context.theme }),
  ...(context?.locale === undefined ? {} : { locale: context.locale }),
  ...(context?.timeZone === undefined ? {} : { timeZone: context.timeZone }),
  containerDimensions: {
    ...(context?.maxWidth === undefined ? {} : { maxWidth: context.maxWidth }),
    ...(context?.maxHeight === undefined ? {} : { maxHeight: context.maxHeight }),
  },
});

/**
 * The handler for a view's `tools/call`.
 *
 * A name the server was not discovered to offer is refused before a request
 * exists, which is what keeps one server's view from reaching another. The
 * call itself is the client's, so it carries the same credential and the same
 * deadline as a model's. A failure comes back as a failed result rather than a
 * transport error: the view that asked decides what to show, exactly as the
 * model decides what to do next.
 */
const callerFor =
  (server: RemoteMcpServer, client: RemoteMcpClient, tools: readonly string[]) =>
  async (params: CallToolRequest['params']): Promise<CallToolResult> => {
    if (!tools.includes(params.name)) {
      throw new Error(`${params.name} is not a tool of ${server.name}.`);
    }
    return Effect.runPromise(
      client.call(params.name, params.arguments ?? {}).pipe(
        Effect.match({
          onFailure: error => ({
            content: [{ type: 'text' as const, text: explain(error) }],
            isError: true,
          }),
          onSuccess: callToolResultOf,
        })
      )
    );
  };

/**
 * The message one text holds, or nothing when it holds none.
 *
 * The surface carries what the sandbox posted as text, and a page that is not
 * the protocol is not a message: it is dropped rather than thrown at the
 * person's screen.
 */
const messageOf = (text: string): JSONRPCMessage | undefined => {
  try {
    const message = JSONRPCMessageSchema.safeParse(JSON.parse(text) as unknown);
    return message.success ? message.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The bridge's transport over a surface that writes text.
 *
 * The bridge assigns `onmessage` and calls `start` when it connects; the text
 * the surface carries in is parsed with the protocol's own schema and handed
 * back through that assignment. Text that arrives before the bridge listens, or
 * that is not a message, is dropped — which is why the surface connects before
 * it lets the view initialize.
 */
const transportOver = (
  host: RemoteMcpAppTransport
): { transport: Transport; receive: (text: string) => void } => {
  const held: { listener?: Transport['onmessage'] } = {};
  const transport: Transport = {
    start: async () => {},
    send: async message => {
      host.send(JSON.stringify(message));
    },
    close: async () => {},
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => held.listener,
    set: (next: Transport['onmessage']) => {
      held.listener = next;
    },
  });
  return {
    transport,
    receive: text => {
      const message = messageOf(text);
      if (message !== undefined) {
        held.listener?.(message);
      }
    },
  };
};

/** The surface-facing half of one bridge: everything the WebView drives. */
const surfaceOf = (bridge: AppBridge): RemoteMcpApp => {
  const deliver: { listening: (text: string) => void } = { listening: () => {} };
  return {
    connect: async host => {
      const bridged = transportOver(host);
      deliver.listening = bridged.receive;
      await bridge.connect(bridged.transport);
    },
    receive: text => {
      deliver.listening(text);
    },
    input: arguments_ => bridge.sendToolInput({ arguments: arguments_ }),
    result: answered => bridge.sendToolResult(callToolResultOf(answered)),
    onInitialized: listener => {
      bridge.addEventListener('initialized', listener);
      return () => {
        bridge.removeEventListener('initialized', listener);
      };
    },
    onSizeChanged: listener => {
      const heard = (size: { width?: number; height?: number }) => {
        listener({ width: size.width, height: size.height });
      };
      bridge.addEventListener('sizechange', heard);
      return () => {
        bridge.removeEventListener('sizechange', heard);
      };
    },
    close: async () => {
      try {
        await bridge.teardownResource({}, { timeout: TEARDOWN_TIMEOUT_MS });
      } catch {
        // The view may already be gone; the surface tears its sandbox down.
      }
      await bridge.close();
    },
  };
};

/** A bridge for one server's view over the client a model's calls use. */
const remoteMcpApp = (
  server: RemoteMcpServer,
  deps: RemoteMcpClientDeps,
  options: RemoteMcpAppOptions
): RemoteMcpApp => {
  const bridge = new AppBridge(
    null,
    options.host ?? { name: 'Kilo', version: '0' },
    HOST_CAPABILITIES,
    { hostContext: hostContextOf(options.context) }
  );
  bridge.oncalltool = callerFor(server, remoteMcpClient(server, deps), options.tools);
  bridge.onopenlink = async params => {
    options.openLink?.(params.url);
    return {};
  };
  bridge.addEventListener('loggingmessage', () => {});
  return surfaceOf(bridge);
};

export type {
  RemoteMcpApp,
  RemoteMcpAppContext,
  RemoteMcpAppOptions,
  RemoteMcpAppResult,
  RemoteMcpAppSize,
  RemoteMcpAppTransport,
} from './app-contract.js';
export { remoteMcpApp };
