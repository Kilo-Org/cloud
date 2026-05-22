import { describe, expect, test } from '@jest/globals';
import { buildReturnToPath } from './authorize-path';

describe('collab authorize return path', () => {
  test('preserves already connected services through OAuth callbacks', () => {
    const path = buildReturnToPath({
      serviceIds: ['github', 'linear'],
      connectedServiceIds: ['slack'],
      organizationId: '0c06733d-0f2c-42ec-921b-c312fb190427',
      step: 1,
    });

    expect(path).toBe(
      '/collab/authorize?services=github%2Clinear&step=1&connected=slack&organizationId=0c06733d-0f2c-42ec-921b-c312fb190427'
    );
  });
});
