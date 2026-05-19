/**
 * Read-only organization KiloClaw trial-expiry rollout inventory.
 *
 * Usage:
 *   pnpm --filter web script:run db kiloclaw-organization-trial-expiry-inventory
 *   pnpm --filter web script:run db kiloclaw-organization-trial-expiry-inventory --as-of 2026-05-19T00:00:00.000Z
 */

import { db } from '@/lib/drizzle';
import {
  evaluateOrganizationTrialExpiryInventory,
  formatOrganizationTrialExpiryInventoryReport,
} from '@/lib/kiloclaw/organization-trial-expiry-inventory';
import { listOrganizationTrialExpiryInventoryRows } from '@kilocode/db/kiloclaw-organization-trial-expiry-candidates';

type InventoryArgs = {
  generatedAtIso: string;
};

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter web script:run db kiloclaw-organization-trial-expiry-inventory',
    '  pnpm --filter web script:run db kiloclaw-organization-trial-expiry-inventory --as-of <ISO>',
    '',
    'This report is read-only. It lists live organization-managed KiloClaw rows by rollout suspension risk without changing lifecycle state.',
  ].join('\n');
}

function parseArgs(args: string[]): InventoryArgs {
  if (args.length === 0) {
    return { generatedAtIso: new Date().toISOString() };
  }

  if (args.length === 2 && args[0] === '--as-of' && !Number.isNaN(Date.parse(args[1]))) {
    return { generatedAtIso: new Date(args[1]).toISOString() };
  }

  throw new Error(usage());
}

export async function run(...args: string[]): Promise<void> {
  const parsedArgs = parseArgs(args);
  const rows = await listOrganizationTrialExpiryInventoryRows(db);
  const inventory = evaluateOrganizationTrialExpiryInventory({
    generatedAtIso: parsedArgs.generatedAtIso,
    rows,
  });

  console.log(formatOrganizationTrialExpiryInventoryReport(inventory));
}
