import type { z } from 'zod';
import { resourcePageSchema, type KubernetesClient } from './kubernetes.js';

const PAGE_SIZE = 8;

export async function listResources<T>(
  kube: Pick<KubernetesClient, 'get'>,
  path: string,
  item: z.ZodType<T>,
  kind: 'Pod' | 'ConfigMap'
): Promise<T[]> {
  const schema = resourcePageSchema(item, kind);
  const items: T[] = [];
  const tokens = new Set<string>();
  let continuation = '';
  let resourceVersion: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (continuation) query.set('continue', continuation);
    const page = await kube.get(`${path}${path.includes('?') ? '&' : '?'}${query}`, schema);
    if (!page || !page.metadata?.resourceVersion || page.items.length > PAGE_SIZE)
      throw new Error('resource_page_invalid');
    resourceVersion ??= page.metadata.resourceVersion;
    if (page.metadata.resourceVersion !== resourceVersion)
      throw new Error('resource_snapshot_changed');
    items.push(...page.items);
    continuation = page.metadata.continue ?? '';
    if (continuation) {
      if (tokens.has(continuation)) throw new Error('resource_page_repeated');
      tokens.add(continuation);
    }
  } while (continuation);
  return items;
}
