import { describe, expect, it } from 'vitest';

import { isRepositorySectionVisible } from './is-repository-section-visible';

describe('isRepositorySectionVisible', () => {
  it('shows the repository section for the Cloud-Agent target (runOnInstance is null)', () => {
    expect(isRepositorySectionVisible(null)).toBe(true);
  });

  it('hides the repository section when a remote instance is selected', () => {
    const remoteInstance = {
      connectionId: 'conn-123',
      name: 'My remote instance',
      projectName: 'my-project',
    };
    expect(isRepositorySectionVisible(remoteInstance)).toBe(false);
  });
});
