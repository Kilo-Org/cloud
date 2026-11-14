/**
 * The built-in server's id, and which ids its tool names already occupy.
 *
 * A server's tools are named `mcp_<id>_<tool>`, so a server's id is the middle
 * of every tool name a model reads and writes. The built-in Kilo server names
 * its tools under `kilo`, which means the id `kilo` and every id that carries
 * on from it past the separator describe names the built-in server may offer
 * itself: a server with the id `kilo_notes` offering `read` would name
 * `mcp_kilo_notes_read`, and two tools with one name leave one of them
 * unreachable.
 *
 * This module has no imports, because it is the name rule both the discovery
 * module and the stored list need, and neither should load the other to read
 * it.
 */

/** The id the built-in server's tools are named under: `mcp_kilo_<tool>`. */
export const KILO_MCP_SERVER_ID = 'kilo';

/**
 * Whether an id already names the built-in server. That is the id itself and
 * every id that begins with it and a separator after it, because those are the
 * ids whose tool names start with the built-in server's `mcp_kilo_` prefix and
 * can therefore collide with its own.
 */
export const isReservedMcpServerId = (id: string): boolean =>
  id === KILO_MCP_SERVER_ID || id.startsWith(`${KILO_MCP_SERVER_ID}_`);
