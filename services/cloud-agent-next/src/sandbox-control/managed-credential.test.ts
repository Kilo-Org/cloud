import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  createControlPlaneCredential,
  isControlPlaneCredential,
  parseControlPlaneCredential,
} from './managed-credential.js';

const SECRET = 'a'.repeat(64);

function credentialFor(sandboxId: string): string {
  return `kcp1.${Buffer.from(sandboxId).toString('base64url')}.kilo.${SECRET}`;
}

const unsafeSandboxIds = [
  '',
  '.',
  '..',
  '../sbx_1',
  'sbx_1/other',
  'sbx_1\\other',
  'sbx_1%2fother',
  'sbx_1?other',
  'sbx_1#other',
  'sbx_1\u0000',
  'sbx_1\n',
  'sbx_1\r',
  'sbx_1\t',
  ' sbx_1',
  'sbx_1 ',
  'sandbox-\u00e9',
  'a'.repeat(257),
];

describe('control-plane managed credential', () => {
  it.each(['kilo', 'github', 'gitlab', 'bitbucket'] as const)(
    'creates opaque random %s aliases with a canonical sandbox routing identity',
    purpose => {
      const sandboxId = 'org-0123456789abcdef';
      const first = createControlPlaneCredential(sandboxId, purpose);
      const second = createControlPlaneCredential(sandboxId, purpose);

      expect(first).toMatch(/^kcp1\.[A-Za-z0-9_-]+\.[a-z]+\.[0-9a-f]{64}$/);
      expect(first.split('.')[1]).toBe(Buffer.from(sandboxId).toString('base64url'));
      expect(first).not.toBe(second);
      expect(isControlPlaneCredential(first)).toBe(true);
      expect(parseControlPlaneCredential(first)).toEqual({ sandboxId, purpose });
      expect(parseControlPlaneCredential(second)).toEqual({ sandboxId, purpose });
    }
  );

  it.each(['a', 'sbx_1', 'usr-abc', 'legacy:user__sandbox.name', 'a'.repeat(256)])(
    'preserves safe sandbox identities without normalization',
    sandboxId => {
      const credential = createControlPlaneCredential(sandboxId, 'kilo');
      expect(parseControlPlaneCredential(credential)).toEqual({ sandboxId, purpose: 'kilo' });
    }
  );

  it.each(unsafeSandboxIds)('rejects an unsafe sandbox identity', sandboxId => {
    expect(() => createControlPlaneCredential(sandboxId, 'kilo')).toThrow(
      'Invalid control-plane credential scope'
    );
    expect(parseControlPlaneCredential(credentialFor(sandboxId))).toBeNull();
  });

  it.each([
    '',
    'kcp1',
    'kcp1.',
    `kcp1.YQ.kilo`,
    `kcp1.YQ.kilo.${SECRET}.extra`,
    `kcp2.YQ.kilo.${SECRET}`,
    `KCP1.YQ.kilo.${SECRET}`,
    `kcp1.YQ..${SECRET}`,
    `kcp1.YQ.KILO.${SECRET}`,
    `kcp1.YQ.other.${SECRET}`,
    `kcp1.YQ=.kilo.${SECRET}`,
    `kcp1.YQ==.kilo.${SECRET}`,
    `kcp1.YR.kilo.${SECRET}`,
    `kcp1.Y Q.kilo.${SECRET}`,
    `kcp1.YQ!.kilo.${SECRET}`,
    `kcp1._w.kilo.${SECRET}`,
    `kcp1.YQ.kilo.`,
    `kcp1.YQ.kilo.${'a'.repeat(63)}`,
    `kcp1.YQ.kilo.${'a'.repeat(65)}`,
    `kcp1.YQ.kilo.${'A'.repeat(64)}`,
    `kcp1.YQ.kilo.${'g'.repeat(64)}`,
    `kcp1.YQ.kilo.${SECRET}\n`,
    `kcp1.${'Y'.repeat(513)}.kilo.${SECRET}`,
  ])('strictly rejects malformed or noncanonical aliases', credential => {
    expect(parseControlPlaneCredential(credential)).toBeNull();
  });

  it.each(['kcp1', 'kcp1.', 'kcp1.invalid', 'kcp1-invalid', `kcp1.${'x'.repeat(10_000)}`])(
    'identifies malformed aliases independently of parsing',
    credential => {
      expect(isControlPlaneCredential(credential)).toBe(true);
      expect(parseControlPlaneCredential(credential)).toBeNull();
    }
  );

  it.each(['', 'kka1.opaque', 'kgh2.opaque', 'raw-upstream-token', 'prefix-kcp1.invalid'])(
    'does not classify unrelated credentials as control-plane aliases',
    credential => {
      expect(isControlPlaneCredential(credential)).toBe(false);
    }
  );
});
