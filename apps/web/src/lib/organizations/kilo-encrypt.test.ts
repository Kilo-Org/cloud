import { isKiloEncryptEnabled } from './kilo-encrypt';

describe('isKiloEncryptEnabled', () => {
  it('is off unless the organization setting is true', () => {
    expect(isKiloEncryptEnabled(undefined)).toBe(false);
    expect(isKiloEncryptEnabled({})).toBe(false);
    expect(isKiloEncryptEnabled({ kilo_encrypt: false })).toBe(false);
    expect(isKiloEncryptEnabled({ kilo_encrypt: true })).toBe(true);
  });
});
