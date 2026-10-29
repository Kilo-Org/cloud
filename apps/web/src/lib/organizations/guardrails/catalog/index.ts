import { mcpIdentityKey, type McpTarget } from '../mcp-identity';
import { fetchKiloMarketplaceMcps } from './kilo-marketplace';
import { getMcpRegistryServer, searchMcpRegistry } from './mcp-registry';
import {
  MCP_CATALOG_PAGE_SIZE,
  type McpCatalogItem,
  type McpCatalogPage,
  type McpCatalogSource,
} from './types';

export type { McpCatalogItem, McpCatalogPage, McpCatalogSource, McpCatalogVariant } from './types';

function matchesQuery(item: McpCatalogItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [item.name, item.description, item.sourceId, item.author ?? ''].some(field =>
    field.toLowerCase().includes(needle)
  );
}

function pageFromOffset(items: McpCatalogItem[], cursor: string | null): McpCatalogPage {
  const parsedOffset = cursor === null ? 0 : Number.parseInt(cursor, 10);
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
  const end = offset + MCP_CATALOG_PAGE_SIZE;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}

export async function browseMcpCatalog(params: {
  source: McpCatalogSource;
  query: string;
  cursor: string | null;
}): Promise<McpCatalogPage> {
  if (params.source === 'mcp_registry') {
    return searchMcpRegistry({ query: params.query, cursor: params.cursor });
  }
  const items = await fetchKiloMarketplaceMcps();
  return pageFromOffset(
    items.filter(item => matchesQuery(item, params.query)),
    params.cursor
  );
}

export async function resolveMcpCatalogItem(params: {
  source: McpCatalogSource;
  sourceId: string;
}): Promise<McpCatalogItem | null> {
  if (params.source === 'mcp_registry') return getMcpRegistryServer(params.sourceId);
  const items = await fetchKiloMarketplaceMcps();
  return items.find(item => item.sourceId === params.sourceId) ?? null;
}

export type McpCatalogMatch = { item: McpCatalogItem; versionHint: string | null };

function findEligibleVariant(items: McpCatalogItem[], identityKey: string): McpCatalogMatch | null {
  for (const item of items) {
    for (const variant of item.variants) {
      if (variant.eligible && variant.identityKey === identityKey) {
        return { item, versionHint: variant.versionHint };
      }
    }
  }
  return null;
}

function registrySearchTerm(target: McpTarget): string {
  if (target.kind === 'remote') return new URL(target.url).hostname;
  return target.identifier.split('/').pop() ?? target.identifier;
}

/**
 * Finds the registry entry that offers exactly this server, checking the Kilo registry first and
 * then the MCP registry. Registry failures are treated as "no match" so callers can fall back to
 * a custom server.
 */
export async function findMcpCatalogMatch(target: McpTarget): Promise<McpCatalogMatch | null> {
  const identityKey = mcpIdentityKey(target);
  const kiloMatch = await fetchKiloMarketplaceMcps().then(
    items => findEligibleVariant(items, identityKey),
    () => null
  );
  if (kiloMatch) return kiloMatch;
  return searchMcpRegistry({ query: registrySearchTerm(target), cursor: null }).then(
    page => findEligibleVariant(page.items, identityKey),
    () => null
  );
}
