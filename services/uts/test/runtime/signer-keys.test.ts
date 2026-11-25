import {
  SignerKeysResultSchema,
  signerOfTokenKid,
  UTS_SIGNER_COUNT,
} from '@kilocode/uts-contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { keySet, resetAllSigners } from './support';
import { env } from './test-env';

beforeAll(async () => {
  await resetAllSigners();
});

describe('SignerKeys entrypoint', () => {
  it('answers the feed caller with every signer exactly once', async () => {
    const result = SignerKeysResultSchema.parse(await env.FEED_SIGNER_KEYS.publicKeys());
    if (result.status !== 'ok') throw new Error('the feed caller was refused');
    expect(result.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, index) => index)
    );
  });

  it('builds a key set of 32 keys: the current and next key of all 16 signers', async () => {
    const { keys } = await keySet();
    expect(keys).toHaveLength(32);
    const perSigner = new Map<number | null, number>();
    for (const key of keys) {
      const signer = signerOfTokenKid(key.kid);
      perSigner.set(signer, (perSigner.get(signer) ?? 0) + 1);
    }
    expect([...perSigner.values()]).toEqual(Array.from({ length: UTS_SIGNER_COUNT }, () => 2));
  });

  it('refuses a caller other than the feed Worker', async () => {
    expect(await env.OTHER_SIGNER_KEYS.publicKeys()).toEqual({ status: 'denied' });
  });

  it('refuses a binding without props', async () => {
    expect(await env.PROPLESS_SIGNER_KEYS.publicKeys()).toEqual({ status: 'denied' });
  });
});
