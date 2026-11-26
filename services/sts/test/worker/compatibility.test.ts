import { errors, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { expect, it } from 'vitest';

// A JOSE verification failure rejects a promise that its async caller adopts and then catches.
// workerd reports that handled rejection as unhandled unless it defers rejection processing to the
// microtask checkpoint (panva/jose#892). The compatibility date enables the deferral, so no config
// names `unhandled_rejection_after_microtask_checkpoint`: this pool's workerd refuses a flag that
// the date already enables. test/repo/compatibility.test.ts pins every STS config to this runtime.
it('defers unhandled rejection processing to the microtask checkpoint', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).sign(privateKey);
  let reported = 0;
  const count = () => {
    reported++;
  };
  addEventListener('unhandledrejection', count);
  try {
    await expect(jwtVerify(token, publicKey, { algorithms: ['RS256'] })).rejects.toThrow(
      errors.JOSEAlgNotAllowed
    );
    // A real task boundary: workerd processes unhandled rejections once the microtask queue drains.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  } finally {
    removeEventListener('unhandledrejection', count);
  }
  expect({
    flag: Cloudflare.compatibilityFlags.unhandled_rejection_after_microtask_checkpoint,
    reported,
  }).toEqual({ flag: true, reported: 0 });
});
