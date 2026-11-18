import { type RemoteMcpToolView } from './remote-mcp-state';

/**
 * Which discovered tool carries which MCP Apps view, for the transcript.
 *
 * The transcript draws a call by the name the model used, and the view it draws
 * is the one the server attached to that tool — read from the server when the
 * app discovered it. Keeping the lookup here, published by `remote-mcp.ts` and
 * read by the row, keeps the transcript's rendering free of the device stores
 * and credentials the discovery itself needs: a row that draws no view needs
 * neither.
 */

let views: ReadonlyMap<string, RemoteMcpToolView> = new Map();

/** Takes the views of the servers that are enabled and discovered now. */
export function publishRemoteMcpViews(next: ReadonlyMap<string, RemoteMcpToolView>): void {
  views = next;
}

/** The view the tool of that name carries, when an enabled server offers one. */
export function remoteServerView(toolName: string): RemoteMcpToolView | undefined {
  return views.get(toolName);
}
