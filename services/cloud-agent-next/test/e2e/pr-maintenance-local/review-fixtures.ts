import { watchPrMaintenanceResultSchema } from '@kilocode/db/cloud-agent-pr-maintenance';
import type { Attempt } from './contracts.js';

export function noPublicationResult(tag: string) {
  return watchPrMaintenanceResultSchema.parse({
    version: 1,
    summary: `Validated synthetic maintenance result ${tag}`,
    changedFiles: [],
    verification: [
      {
        command: 'synthetic read-only local acceptance',
        outcome: 'passed',
        summary: 'No repository change or publication was requested.',
        evidenceUrls: [],
      },
    ],
    publication: { status: 'not_attempted', reason: 'This local fixture does not publish.' },
    problems: [
      {
        problemKey: 'review:initial',
        contentFingerprint: 'synthetic-initial',
        disposition: 'not_actionable',
        reason: 'Synthetic fixture has no code change to make.',
        evidence: [],
        threadId: null,
        reply: null,
        resolve: false,
      },
    ],
    needsInput: null,
  });
}

export function maintenanceFixturePrompt(tag: string, attempt: Pick<Attempt, 'kind' | 'gate'>) {
  if (attempt.kind === 'result-continuation') {
    return `__e2e_scope__:${attempt.gate}\n__fake__:realistic:${JSON.stringify(noPublicationResult(tag))}\n<environment_details>\nSynthetic local acceptance. Do not edit, commit, push, or call GitHub.\n</environment_details>`;
  }
  const scope = attempt.kind === 'stop-before-start' ? attempt.gate : tag;
  const conversation =
    attempt.kind === 'question'
      ? `question:${attempt.gate}:Continue this synthetic maintenance check?`
      : `gate:${attempt.gate}`;
  return `__e2e_scope__:${scope}\n__fake__:${conversation}\nSynthetic local acceptance only. Do not edit, commit, push, or call GitHub.`;
}

export function continuationText(tag: string) {
  return `plain-continuation-${tag}`;
}
