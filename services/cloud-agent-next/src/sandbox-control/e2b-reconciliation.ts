import type { E2BAllocationConfig } from '../sandbox-state/model/allocation.js';
import { listE2BSandboxes, type E2BSandboxInfo } from './e2b-api.js';
import { E2B_SCAN_TIMEOUT_MS, e2bCreateMetadata } from './e2b-runtime.js';

const MAX_SCAN_PAGES = 5;
const MAX_SCAN_RESULTS = 100;
const MAX_SCAN_PASSES = 2;
const PAGE_SIZE = 20;

export function matchesE2BSandboxIntent(
  info: E2BSandboxInfo,
  config: E2BAllocationConfig,
  intentId: string
): boolean {
  return (
    info.templateID === config.templateId &&
    info.cpuCount === config.resourceProfile.cpuCount &&
    info.memoryMB === config.resourceProfile.memoryMB &&
    Object.entries(e2bCreateMetadata(config, intentId)).every(
      ([key, value]) => info.metadata[key] === value
    )
  );
}

export async function reconcileE2BCreate(
  apiKey: string,
  config: E2BAllocationConfig,
  intentId: string
): Promise<E2BSandboxInfo | null> {
  if (config.submissionState !== 'submitted') return null;
  // A list that would start at or after the window has expired does not scan: the
  // reducer's exhaustion transition owns that case.
  if (Date.now() >= config.reconciliationDeadlineAt) return null;
  const deadlineAt = Math.min(Date.now() + E2B_SCAN_TIMEOUT_MS, config.reconciliationDeadlineAt);
  let pages = 0;
  let results = 0;
  try {
    for (let pass = 0; pass < MAX_SCAN_PASSES; pass++) {
      const candidates = new Map<string, E2BSandboxInfo>();
      const seenTokens = new Set<string>();
      let nextToken: string | undefined;
      for (;;) {
        if (Date.now() >= deadlineAt || pages >= MAX_SCAN_PAGES || results >= MAX_SCAN_RESULTS) {
          return null;
        }
        const page = await listE2BSandboxes(apiKey, config, intentId, {
          nextToken,
          limit: Math.min(PAGE_SIZE, MAX_SCAN_RESULTS - results),
          deadlineAt,
        });
        pages++;
        results += page.items.length;
        if (Date.now() >= deadlineAt) return null;
        for (const item of page.items) {
          if (matchesE2BSandboxIntent(item, config, intentId)) candidates.set(item.sandboxID, item);
        }
        if (!page.nextToken) {
          if (candidates.size === 1) return candidates.values().next().value ?? null;
          if (candidates.size > 1) return null;
          break;
        }
        if (seenTokens.has(page.nextToken)) return null;
        seenTokens.add(page.nextToken);
        nextToken = page.nextToken;
      }
    }
  } catch {
    return null;
  }
  return null;
}
