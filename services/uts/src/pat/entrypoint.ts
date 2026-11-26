import type { UtsEnvironment, UtsPatLookupResult } from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { callerOf } from '../callers';
import { patLookupsInFlight, readConfig, type Env } from '../env';
import {
  UNSERVED_RETRY_SECONDS,
  identityStorePatLookup,
  lookupPatHash,
  patStoreBinding,
} from './lookup';

/**
 * The Workers that may call the PAT lookup (`UTS_PAT_LOOKUP_ENTRYPOINT`), by the deployed name
 * their binding carries as `props.caller`. Only a deploy in the account can set props, so the
 * check is deploy-level trust, as for the `SignerKeys` entrypoint and the STS broker (design 6.4).
 * A verifying Worker joins its environment's list when it starts to accept PATs; `test/repo` keeps
 * every other config from binding the mint Worker. Development lists the caller the runtime tests
 * and a local verifier use.
 */
export const PAT_LOOKUP_CALLERS: Readonly<Record<UtsEnvironment, readonly string[]>> = {
  production: [],
  staging: [],
  development: ['uts-verifier-local'],
};

/**
 * The PAT lookup for Worker verifiers: the `PatLookup` port of `@kilocode/verify` over a service
 * binding. Placement does not apply to a named entrypoint, so the lookup runs where the caller
 * runs and sends its one statement through the PAT Hyperdrive config from there. A caller that is
 * not listed, or an environment that binds no PAT config, gets `unavailable` with a 60-second
 * retry, so the verifier answers 503 and never allows.
 */
export class PatLookup extends WorkerEntrypoint<Env> {
  async lookup(hash: unknown): Promise<UtsPatLookupResult> {
    const config = readConfig(this.env);
    const caller = callerOf(this.ctx.props);
    if (caller === null || !PAT_LOOKUP_CALLERS[config.environment].includes(caller)) {
      console.warn(JSON.stringify({ event: 'uts.pat_lookup.refused', caller }));
      return { status: 'unavailable', retryAfterSeconds: UNSERVED_RETRY_SECONDS };
    }
    const binding = patStoreBinding(this.env);
    if (binding.kind === 'unprovisioned') {
      return { status: 'unavailable', retryAfterSeconds: UNSERVED_RETRY_SECONDS };
    }
    return await lookupPatHash(
      typeof hash === 'string' ? hash : '',
      identityStorePatLookup(binding.connectionString, this.ctx),
      patLookupsInFlight(this.env)
    );
  }
}
