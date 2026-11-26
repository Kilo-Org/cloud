import { WorkerEntrypoint } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import UtsMintDev from '../../src/dev-index';
import UtsMint from '../../src/index';
import { resetSignerKeysIsolate } from '../../src/signer-keys';
import { fetchSignerKeys } from './support';
import { env } from './test-env';

/**
 * A deployed Worker delivers a service binding's `props` only to an entrypoint class; workerd
 * delivers them to a plain handler object too, so the binding calls below pass with either shape
 * and the class check is what holds the deployed behaviour.
 */
describe('mint Worker default entrypoint', () => {
  it('is a WorkerEntrypoint class in the deployed and the development entry', () => {
    expect(UtsMint.prototype).toBeInstanceOf(WorkerEntrypoint);
    expect(UtsMintDev.prototype).toBeInstanceOf(WorkerEntrypoint);
  });

  it("receives the feed binding's props through the default entrypoint and refuses a binding without them", async () => {
    resetSignerKeysIsolate();
    expect((await fetchSignerKeys(env.FEED_MINT)).status).toBe(200);
    expect((await fetchSignerKeys(env.PROPLESS_MINT)).status).toBe(404);
  });
});
