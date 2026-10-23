import {
  remoteMcpApp,
  type RemoteMcpApp,
  type RemoteMcpAppContext,
  remoteMcpClient,
  type RemoteMcpClientDeps,
  type RemoteMcpResource,
  type RemoteMcpServer,
} from '@kilocode/harness-sdk/plugins/remote-mcp';
import { Effect } from 'effect';

import { contentSecurityPolicy, MAX_VIEW_BYTES, viewDocument } from './remote-mcp-app';
import { type RemoteMcpToolView } from './remote-mcp-state';

/**
 * Drawing one MCP Apps view: the document it runs and the bridge it calls back
 * through, from the server, its deps and its tools.
 *
 * The transcript knows a call by the name the model used; the view knows it by
 * the server's own name, and reaches the server with the same credential and
 * failure surface a model's call does. `remote-mcp.ts` resolves those three
 * from what was discovered and hands them here, so this module never reads the
 * stored list and never mints a credential.
 */

/** What a view is drawn and driven from: the server, its deps, its tools. */
export type RemoteMcpViewSource = {
  readonly server: RemoteMcpServer;
  readonly deps: RemoteMcpClientDeps;
  readonly tools: readonly string[];
};

/** What a view's document is, once read: it, or why there is none. */
export type RemoteMcpViewDocument =
  | { readonly kind: 'ready'; readonly html: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' };

/**
 * The document the view is drawn from, held to the policy the resource
 * declared. It is read off the same server the tool came from, under the same
 * deadline and credential rules as a call, so a server that refuses this
 * session is reported the way a refused call is.
 */
export async function readViewDocument(
  source: RemoteMcpViewSource,
  view: RemoteMcpToolView
): Promise<RemoteMcpViewDocument> {
  try {
    const read = await Effect.runPromise(
      remoteMcpClient(source.server, source.deps)
        .resource(view.resourceUri)
        .pipe(
          Effect.match({
            onFailure: () => ({ ok: false as const }),
            onSuccess: (resource: RemoteMcpResource) => ({ ok: true as const, resource }),
          })
        )
    );
    if (!read.ok) {
      return { kind: 'unavailable' };
    }
    const html = read.resource.text;
    if (html === undefined || html.trim() === '') {
      return { kind: 'empty' };
    }
    if (html.length > MAX_VIEW_BYTES) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'ready',
      html: viewDocument(html, contentSecurityPolicy(read.resource._meta)),
    };
  } catch {
    // A read that threw rather than failed is still nothing to draw.
    return { kind: 'unavailable' };
  }
}

/** The bridge for one view, over the client a model's calls use. */
export function openViewBridge(
  source: RemoteMcpViewSource,
  options: { readonly context?: RemoteMcpAppContext; readonly openLink?: (uri: string) => void }
): RemoteMcpApp {
  return remoteMcpApp(source.server, source.deps, { tools: source.tools, ...options });
}
