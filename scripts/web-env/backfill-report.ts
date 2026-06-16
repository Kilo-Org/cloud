export type BackfillReport = {
  migrated: string[];
  alreadySensitive: string[];
  productionMismatches: string[];
  stagingUnresolved: string[];
  skipped: string[];
  failed: string[];
};

export function createBackfillReport(): BackfillReport {
  return {
    migrated: [],
    alreadySensitive: [],
    productionMismatches: [],
    stagingUnresolved: [],
    skipped: [],
    failed: [],
  };
}

export function formatBackfillReport(report: BackfillReport, timestamp: string): string {
  const sections: [string, string[]][] = [
    ['Migrated to 1Password and converted to sensitive', report.migrated],
    ['Already sensitive and missing from 1Password', report.alreadySensitive],
    ['Unresolved cross-project production mismatches', report.productionMismatches],
    ['Unresolved staging mismatches or inaccessible state', report.stagingUnresolved],
    ['Operator-skipped non-secrets', report.skipped],
    ['Failed or partially converted variables', report.failed],
  ];
  const lines = [`Web environment backfill report - ${timestamp}`];
  for (const [heading, variables] of sections) {
    lines.push('', heading);
    lines.push(
      ...(variables.length === 0 ? ['- None'] : variables.sort().map(name => `- ${name}`))
    );
  }
  return lines.join('\n');
}
