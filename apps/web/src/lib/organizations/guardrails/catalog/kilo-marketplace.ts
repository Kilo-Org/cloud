import { load } from 'js-yaml';
import * as z from 'zod';
import { mcpIdentityKey, normalizeRemoteMcpUrl } from '../mcp-identity';
import { parseLauncherCommand } from '../mcp-launcher';
import type { McpCatalogItem, McpCatalogVariant } from './types';

export const KILO_MCP_MARKETPLACE_URL =
  'https://raw.githubusercontent.com/Kilo-Org/kilo-marketplace/main/mcps/marketplace.yaml';

const PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}/g;
const PLACEHOLDER_TOKEN = '__PLACEHOLDER__';

const MarketplaceItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  author: z.string().optional(),
  url: z.string().optional(),
  content: z.array(z.object({ name: z.string(), content: z.string() })),
});

const MarketplaceFileSchema = z.object({ items: z.array(z.unknown()) });

const VariantContentSchema = z.object({
  url: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.array(z.string()).optional(),
});

function adaptVariant(name: string, content: string): McpCatalogVariant {
  const label = name;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content.replace(PLACEHOLDER_PATTERN, PLACEHOLDER_TOKEN));
  } catch {
    return { eligible: false, label, reason: 'The configuration can’t be read.' };
  }
  const parsed = VariantContentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { eligible: false, label, reason: 'The configuration can’t be read.' };
  }
  const { url, command, args } = parsed.data;

  if (url !== undefined) {
    if (url.includes(PLACEHOLDER_TOKEN)) {
      return {
        eligible: false,
        label,
        reason: 'The URL depends on your account. Add it with Custom instead.',
      };
    }
    const normalized = normalizeRemoteMcpUrl(url);
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

  if (command === undefined) {
    return { eligible: false, label, reason: 'The configuration has no command or URL.' };
  }
  const argv = Array.isArray(command) ? command : [command, ...(args ?? [])];
  const launched = parseLauncherCommand(argv);
  if (!launched.eligible) return { eligible: false, label, reason: launched.reason };
  const target = {
    kind: 'package',
    ecosystem: launched.ecosystem,
    identifier: launched.identifier,
  } as const;
  return {
    eligible: true,
    label,
    identityKey: mcpIdentityKey(target),
    target,
    versionHint: launched.versionHint,
  };
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

export function adaptKiloMarketplaceYaml(yamlText: string): McpCatalogItem[] {
  const file = MarketplaceFileSchema.safeParse(load(yamlText));
  if (!file.success) throw new Error('The Kilo marketplace file has an unexpected shape.');
  const items: McpCatalogItem[] = [];
  for (const rawItem of file.data.items) {
    const item = MarketplaceItemSchema.safeParse(rawItem);
    if (!item.success) continue;
    items.push({
      source: 'kilo_marketplace',
      sourceId: item.data.id,
      name: item.data.name,
      description: item.data.description,
      author: item.data.author ?? null,
      homepageUrl: item.data.url ?? null,
      variants: dedupeVariants(
        item.data.content.map(variant => adaptVariant(variant.name, variant.content))
      ),
    });
  }
  return items;
}

export async function fetchKiloMarketplaceMcps(): Promise<McpCatalogItem[]> {
  const response = await fetch(KILO_MCP_MARKETPLACE_URL, {
    next: { revalidate: 3600 },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The Kilo marketplace responded with ${response.status}.`);
  }
  return adaptKiloMarketplaceYaml(await response.text());
}
