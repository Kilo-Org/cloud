import { describe, expect, it } from 'vitest';
import { buildCloudAgentRules } from './cloud-agent-rules.js';
import {
  WORKSPACE_ARTIFACT_MAX_FILE_BYTES,
  WORKSPACE_ARTIFACT_MAX_FILES,
  WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES,
} from './workspace-artifacts.js';

const MIB = 1024 * 1024;

describe('buildCloudAgentRules artifacts guidance', () => {
  it('keeps the ephemeral line and omits the Artifacts section by default', () => {
    const rules = buildCloudAgentRules();
    expect(rules).toContain(
      'The filesystem is ephemeral and will not persist after the session ends.'
    );
    expect(rules).not.toContain('except for files saved in `/artifacts`');
    expect(rules).not.toContain('## Artifacts');
  });

  it('omits the Artifacts section when artifacts is false', () => {
    const rules = buildCloudAgentRules({ artifacts: false });
    expect(rules).toContain(
      'The filesystem is ephemeral and will not persist after the session ends.'
    );
    expect(rules).not.toContain('## Artifacts');
  });

  it('adds the Artifacts section and amended ephemeral line when artifacts is true', () => {
    const rules = buildCloudAgentRules({ artifacts: true });
    expect(rules).toContain(
      'The filesystem is ephemeral and will not persist after the session ends, except for files saved in `/artifacts` (see Artifacts).'
    );
    expect(rules).toContain('## Artifacts');
    expect(rules.indexOf('## Artifacts')).toBeGreaterThan(rules.indexOf('## Dev Servers'));
    expect(rules).toContain('The user can view and download everything in `/artifacts`');
    expect(rules).toContain(
      'Saved files are kept until the workspace or standalone session is deleted.'
    );
    expect(rules).not.toMatch(/R2|synchroniz/i);
  });

  it('builds every limit from the shared workspace artifact constants', () => {
    const rules = buildCloudAgentRules({ artifacts: true });
    const fileMiB = WORKSPACE_ARTIFACT_MAX_FILE_BYTES / MIB;
    const totalMiB = WORKSPACE_ARTIFACT_MAX_TOTAL_BYTES / MIB;
    expect(rules).toContain(
      `Limits: ${fileMiB.toLocaleString('en-US')} MiB per file, ${totalMiB.toLocaleString('en-US')} MiB and ${WORKSPACE_ARTIFACT_MAX_FILES.toLocaleString('en-US')} files in total.`
    );
    expect(rules).toContain('named `node_modules`, `__pycache__`, or `venv`');
  });
});
