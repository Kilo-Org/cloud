import { tokenKid, UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import type { PublicKeysResult } from '../../src/dos/UtsSignerDO';
import { signerKeysResult } from '../../src/signer-keys';

const X = 'B'.repeat(43);

function answer(signer: number): PromiseSettledResult<PublicKeysResult> {
  return {
    status: 'fulfilled',
    value: {
      status: 'ok',
      signer,
      keys: [
        { kty: 'OKP', crv: 'Ed25519', x: X, kid: tokenKid(signer, X), alg: 'EdDSA', use: 'sig' },
      ],
    },
  };
}

const all = () => Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => answer(signer));
const failed: PromiseSettledResult<PublicKeysResult> = {
  status: 'rejected',
  reason: new Error('Durable Object reset because its code was updated'),
};
const refused: PromiseSettledResult<PublicKeysResult> = {
  status: 'fulfilled',
  value: { status: 'misconfigured', reason: 'signer object was not created by its signer name' },
};

describe('signerKeysResult', () => {
  it('lists every signer once when all 16 answer', () => {
    const result = signerKeysResult(all());
    if (result.status !== 'ok') throw new Error(`answered ${result.status}`);
    expect(result.signers.map(entry => entry.signer)).toEqual(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) => signer)
    );
  });

  it('is unavailable when a signer call failed after its retries', () => {
    const answers = all();
    answers[4] = failed;
    expect(signerKeysResult(answers)).toEqual({ status: 'unavailable' });
  });

  it('is misconfigured when a signer refused, even beside a failed call', () => {
    const answers = all();
    answers[2] = failed;
    answers[9] = refused;
    expect(signerKeysResult(answers)).toEqual({ status: 'misconfigured' });
  });
});
