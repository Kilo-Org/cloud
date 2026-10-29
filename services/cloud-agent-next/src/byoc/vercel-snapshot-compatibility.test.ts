import { describe, expect, it } from 'vitest';
import { vercelSnapshotBaseImage } from './vercel-snapshot-compatibility.js';

describe('vercelSnapshotBaseImage', () => {
  it('scopes the identity to the credential, account, project and actual base snapshot', () => {
    const identity = vercelSnapshotBaseImage({
      credentialId: 'credential-1',
      teamId: 'team-1',
      projectId: 'project-1',
      runtimeBuildId: 'runtime-1',
      baseSnapshotId: 'snap-base-1',
    });
    expect(JSON.parse(identity)).toEqual([
      'vercel',
      'credential-1',
      'team-1',
      'project-1',
      'runtime-1',
      'snap-base-1',
    ]);
  });

  it('changes when the account, project, runtime build or base snapshot changes', () => {
    const base = {
      credentialId: 'credential-1',
      teamId: 'team-1',
      projectId: 'project-1',
      runtimeBuildId: 'runtime-1',
      baseSnapshotId: 'snap-base-1',
    };
    const identity = vercelSnapshotBaseImage(base);
    expect(vercelSnapshotBaseImage({ ...base, teamId: 'team-2' })).not.toBe(identity);
    expect(vercelSnapshotBaseImage({ ...base, projectId: 'project-2' })).not.toBe(identity);
    expect(vercelSnapshotBaseImage({ ...base, credentialId: 'credential-2' })).not.toBe(identity);
    expect(vercelSnapshotBaseImage({ ...base, runtimeBuildId: 'runtime-2' })).not.toBe(identity);
    expect(vercelSnapshotBaseImage({ ...base, baseSnapshotId: 'snap-base-2' })).not.toBe(identity);
  });
});
