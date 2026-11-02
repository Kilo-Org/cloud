import type { McpTarget } from '../mcp-identity';

export type McpCatalogSource = 'kilo_marketplace' | 'mcp_registry';

export type McpCatalogVariant =
  | {
      eligible: true;
      label: string;
      identityKey: string;
      target: McpTarget;
      versionHint: string | null;
    }
  | { eligible: false; label: string; reason: string };

export type McpCatalogItem = {
  source: McpCatalogSource;
  sourceId: string;
  name: string;
  description: string;
  author: string | null;
  homepageUrl: string | null;
  variants: McpCatalogVariant[];
};

export type McpCatalogPage = {
  items: McpCatalogItem[];
  nextCursor: string | null;
};

export const MCP_CATALOG_PAGE_SIZE = 20;
