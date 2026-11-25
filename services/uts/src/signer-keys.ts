import { UTS_SIGNER_COUNT, type SignerKeysResult } from '@kilocode/uts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { getSignerStub } from './dos/stubs';
import { FEED_DEPLOYMENTS, readConfig, type Env } from './env';

export type SignerKeysProps = { caller: string };

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/**
 * The UTS-internal entrypoint the feed Worker reads signer public keys from. The feed Worker binds
 * it with `props: { caller: '<its deployed name>' }`; only a deploy in the account can set props,
 * so the caller check is deploy-level trust, as for the STS broker (design 6.4). Every other
 * caller is refused. The repository check in `test/repo` keeps every other config from binding it.
 */
export class SignerKeys extends WorkerEntrypoint<Env, SignerKeysProps> {
  async publicKeys(): Promise<SignerKeysResult> {
    const config = readConfig(this.env);
    const props = CallerPropsSchema.safeParse(this.ctx.props);
    const caller = props.success ? props.data.caller : null;
    if (caller !== FEED_DEPLOYMENTS[config.environment]) {
      console.warn(JSON.stringify({ event: 'uts.signer_keys.refused', caller }));
      return { status: 'denied' };
    }
    const signers = await Promise.all(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) =>
        withDORetry(
          () => getSignerStub(this.env, config, signer),
          stub => stub.publicKeys(),
          'uts.signer.publicKeys'
        )
      )
    );
    return { status: 'ok', signers };
  }
}
