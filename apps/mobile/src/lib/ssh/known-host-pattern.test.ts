import { describe, expect, it } from 'vitest';

import { hostPatternDisplay } from './known-host-pattern';

describe('hostPatternDisplay', () => {
  it('drops the brackets around a host with a port', () => {
    expect(hostPatternDisplay('[web-1.kilo.test]:2222')).toBe('web-1.kilo.test:2222');
    expect(hostPatternDisplay('[10.0.0.12]:22')).toBe('10.0.0.12:22');
  });

  it('leaves a default-port pattern as it is', () => {
    expect(hostPatternDisplay('bastion.kilo.test')).toBe('bastion.kilo.test');
    expect(hostPatternDisplay('bastion.kilo.test:2200')).toBe('bastion.kilo.test:2200');
  });
});
