import * as z from 'zod';
import { mcpIdentityKey, normalizePackageIdentifier, normalizeRemoteMcpUrl } from '../mcp-identity';
import type { McpCatalogItem, McpCatalogPage, McpCatalogVariant } from './types';
import { MCP_CATALOG_PAGE_SIZE } from './types';

export const MCP_REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io/v0.1';

const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

const RegistryPackageSchema = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().optional(),
  transport: z.object({ type: z.string() }).optional(),
});

const RegistryRemoteSchema = z.object({
  type: z.string(),
  url: z.string(),
});

const RegistryEntrySchema = z.object({
  server: z.object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).optional(),
    packages: z.array(RegistryPackageSchema).optional(),
    remotes: z.array(RegistryRemoteSchema).optional(),
  }),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const RegistryListSchema = z.object({
  servers: z.array(z.unknown()),
  metadata: z.object({ nextCursor: z.string().optional() }).optional(),
});

type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
type RegistryPackage = z.infer<typeof RegistryPackageSchema>;
type RegistryRemote = z.infer<typeof RegistryRemoteSchema>;

const REMOTE_TRANSPORTS = new Set(['streamable-http', 'sse']);

function adaptPackage(pkg: RegistryPackage): McpCatalogVariant {
  const label = `${pkg.registryType}: ${pkg.identifier}`;
  if (pkg.registryType !== 'npm' && pkg.registryType !== 'pypi') {
    return {
      eligible: false,
      label,
      reason: `${pkg.registryType} packages aren’t supported yet.`,
    };
  }
  if (pkg.transport !== undefined && pkg.transport.type !== 'stdio') {
    return { eligible: false, label, reason: 'The package uses an HTTP transport.' };
  }
  const identifier = normalizePackageIdentifier(pkg.registryType, pkg.identifier);
  if (!identifier.ok) return { eligible: false, label, reason: identifier.reason };
  const target = {
    kind: 'package',
    ecosystem: pkg.registryType,
    identifier: identifier.value,
  } as const;
  return {
    eligible: true,
    label,
    identityKey: mcpIdentityKey(target),
    target,
    versionHint: pkg.version && /^[0-9]/.test(pkg.version) ? pkg.version : null,
  };
}

function adaptRemote(remote: RegistryRemote): McpCatalogVariant {
  const label = `remote: ${remote.url}`;
  if (!REMOTE_TRANSPORTS.has(remote.type)) {
    return { eligible: false, label, reason: `The ${remote.type} transport isn’t supported.` };
  }
  const normalized = normalizeRemoteMcpUrl(remote.url);
  if (!normalized.ok) return { eligible: false, label, reason: normalized.reason };
  const target = { kind: 'remote', url: normalized.value } as const;
  return {
    eligible: true,
    label,
    identityKey: mcpIdentityKey(target),
    target,
    versionHint: null,
  };
}

function isActive(entry: RegistryEntry): boolean {
  const meta = z
    .object({ status: z.string().optional() })
    .safeParse(entry._meta?.[OFFICIAL_META_KEY]);
  return !meta.success || meta.data.status === undefined || meta.data.status === 'active';
}

function dedupeVariants(variants: McpCatalogVariant[]): McpCatalogVariant[] {
  const seen = new Set<string>();
  return variants.filter(variant => {
    if (!variant.eligible) return true;
    if (seen.has(variant.identityKey)) return false;
    seen.add(variant.identityKey);
    return true;
  });
}

function adaptEntry(entry: RegistryEntry): McpCatalogItem {
  const { server } = entry;
  return {
    source: 'mcp_registry',
    sourceId: server.name,
    name: server.title ?? server.name,
    description: server.description ?? '',
    author: null,
    homepageUrl: server.websiteUrl ?? server.repository?.url ?? null,
    variants: dedupeVariants([
      ...(server.remotes ?? []).map(adaptRemote),
      ...(server.packages ?? []).map(adaptPackage),
    ]),
  };
}

export function adaptMcpRegistryList(payload: unknown): McpCatalogPage {
  const list = RegistryListSchema.safeParse(payload);
  if (!list.success) throw new Error('The MCP registry returned an unexpected response.');
  const items: McpCatalogItem[] = [];
  for (const rawEntry of list.data.servers) {
    const entry = RegistryEntrySchema.safeParse(rawEntry);
    if (entry.success && isActive(entry.data)) items.push(adaptEntry(entry.data));
  }
  return { items, nextCursor: list.data.metadata?.nextCursor ?? null };
}

async function fetchRegistryJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The MCP registry responded with ${response.status}.`);
  }
  return response.json();
}

export async function searchMcpRegistry(params: {
  query: string;
  cursor: string | null;
}): Promise<McpCatalogPage> {
  const url = new URL(`${MCP_REGISTRY_BASE_URL}/servers`);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(MCP_CATALOG_PAGE_SIZE));
  if (params.query.trim() !== '') url.searchParams.set('search', params.query.trim());
  if (params.cursor !== null) url.searchParams.set('cursor', params.cursor);
  return adaptMcpRegistryList(await fetchRegistryJson(url));
}

export async function getMcpRegistryServer(name: string): Promise<McpCatalogItem | null> {
  const url = new URL(
    `${MCP_REGISTRY_BASE_URL}/servers/${encodeURIComponent(name)}/versions/latest`
  );
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`The MCP registry responded with ${response.status}.`);
  }
  const entry = RegistryEntrySchema.safeParse(await response.json());
  if (!entry.success || !isActive(entry.data)) return null;
  return adaptEntry(entry.data);
}
