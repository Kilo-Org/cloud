import { UTS_SIGNER_KEYS_ENTRYPOINT } from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as devEntry from '../../src/dev-index';
import * as deployedEntry from '../../src/index';
import { readSignerKeys, resetKeySetShards } from './support';
import { config, env } from './test-env';

/**
 * The feed Worker reads signer keys through a binding to the mint Worker's named entrypoint, with
 * its deployed name as `props`; these calls go through real service bindings in workerd.
 */
describe('SignerKeys entrypoint', () => {
  it('is a named WorkerEntrypoint export of the deployed and the development entry', () => {
    for (const entry of [deployedEntry, devEntry]) {
      expect(Object.keys(entry)).toContain(UTS_SIGNER_KEYS_ENTRYPOINT);
      expect(entry.SignerKeys.prototype).toBeInstanceOf(WorkerEntrypoint);
    }
  });

  it("receives the feed binding's props and answers every signer", async () => {
    await resetKeySetShards();
    const read = await readSignerKeys(env.FEED_MINT);
    if (read.status !== 'answered') throw new Error(`feed caller got ${read.status}`);
    expect(read.answer.signers.every(entry => entry.status === 'ok')).toBe(true);
  });

  it('refuses a binding that names another caller or carries no props', async () => {
    expect(await readSignerKeys(env.OTHER_MINT)).toEqual({ status: 'refused' });
    expect(await readSignerKeys(env.PROPLESS_MINT)).toEqual({ status: 'refused' });
  });

  it("serves no signer keys from the default entrypoint, even with the feed Worker's props", async () => {
    const response = await env.DEFAULT_MINT.fetch(
      `${config.endpoints.issuer}/internal/signer-keys`
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
