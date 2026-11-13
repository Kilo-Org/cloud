import { describe, expect, it } from 'vitest';

import { getCloudTriggersUrl } from './cloud-triggers-url';

describe('getCloudTriggersUrl', () => {
  it('opens the personal triggers page', () => {
    expect(getCloudTriggersUrl('https://kilo.ai')).toBe('https://kilo.ai/cloud/triggers');
  });

  it('opens the selected organization triggers page', () => {
    expect(getCloudTriggersUrl('https://kilo.ai', 'org-1')).toBe(
      'https://kilo.ai/organizations/org-1/cloud/triggers'
    );
  });

  it('never doubles the slash a base URL already ends with', () => {
    expect(getCloudTriggersUrl('https://kilo.ai/', 'org-1')).toBe(
      'https://kilo.ai/organizations/org-1/cloud/triggers'
    );
  });

  it('treats a missing organization as the personal scope', () => {
    expect(getCloudTriggersUrl('https://kilo.ai', null)).toBe('https://kilo.ai/cloud/triggers');
  });
});
