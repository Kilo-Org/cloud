import { describe, expect, it } from 'vitest';
import { buildCloudAgentRules } from './cloud-agent-rules.js';

describe('buildCloudAgentRules', () => {
  it('includes Git branch guidance with the existing sections', () => {
    const rules = buildCloudAgentRules();

    expect(rules).toContain('## Git Branches');
    expect(rules).toContain(
      'Commit and push to the branch this session started on. Do not create or switch branches, or move the work to a differently named branch, unless the user explicitly asks for it.'
    );
    expect(rules).toContain('# Cloud Agent Environment');
    expect(rules).toContain('## Command Execution');
  });
});
