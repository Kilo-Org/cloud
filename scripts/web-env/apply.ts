import type { OnePasswordAdapter } from './onepassword.js';
import { buildWriteOperations, type EnvironmentValues, type WebEnvMode } from './plan.js';
import { operationId, writeResumeJournal, type ResumeJournal } from './resume.js';
import type { VercelAdapter } from './vercel.js';

export class PartialRemoteFailureError extends Error {
  readonly journal: ResumeJournal;
  readonly journalPath: string;

  constructor(journal: ResumeJournal, journalPath: string) {
    super(`Remote update stopped at ${journal.failed}. Provider output was redacted.`);
    this.journal = journal;
    this.journalPath = journalPath;
  }
}

export async function applyRemoteChanges(options: {
  repoRoot: string;
  mode: WebEnvMode;
  variableName: string;
  sensitive: boolean;
  values: EnvironmentValues;
  vercel: Pick<VercelAdapter, 'writeVariable'>;
  onePassword: Pick<OnePasswordAdapter, 'writeProductionValue'>;
  now?: () => Date;
}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const operations = buildWriteOperations(options.sensitive);
  const completed: string[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (!operation) continue;
    try {
      await options.vercel.writeVariable({
        mode: options.mode,
        project: operation.project,
        environment: operation.environment,
        key: options.variableName,
        value: options.values[operation.environment],
        sensitive: operation.sensitive,
        expectedType: operation.expectedType,
      });
      completed.push(operationId(operation));
    } catch {
      const journal: ResumeJournal = {
        version: 1,
        variableName: options.variableName,
        sensitive: options.sensitive,
        createdAt: now().toISOString(),
        completed,
        failed: operationId(operation),
        pending: operations.slice(index + 1).map(operationId),
        onePassword: options.sensitive ? 'pending' : 'skipped',
      };
      const journalPath = await writeResumeJournal(options.repoRoot, journal);
      throw new PartialRemoteFailureError(journal, journalPath);
    }
  }

  if (!options.sensitive) return;
  try {
    await options.onePassword.writeProductionValue(
      options.mode,
      options.variableName,
      options.values.production
    );
  } catch {
    const journal: ResumeJournal = {
      version: 1,
      variableName: options.variableName,
      sensitive: true,
      createdAt: now().toISOString(),
      completed,
      failed: '1Password',
      pending: [],
      onePassword: 'failed',
    };
    const journalPath = await writeResumeJournal(options.repoRoot, journal);
    throw new PartialRemoteFailureError(journal, journalPath);
  }
}
