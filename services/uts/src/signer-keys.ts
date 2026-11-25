import {
  SIGNER_KEYS_HTTP_STATUS,
  UTS_SIGNER_COUNT,
  type SignerKeysResult,
  type SignerPublicKeys,
} from '@kilocode/uts-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import { z } from 'zod';
import type { PublicKeysResult } from './dos/UtsSignerDO';
import { getSignerStub } from './dos/stubs';
import { FEED_DEPLOYMENTS, type Env, type UtsConfig } from './env';
import { jsonResponse } from './responses';

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/** The caller a service binding's `props` name; null for a request that came from the internet. */
function callerOf(props: unknown): string | null {
  const parsed = CallerPropsSchema.safeParse(props);
  return parsed.success ? parsed.data.caller : null;
}

/**
 * Combines the 16 signer answers, in signer order, into one result. A refused object stays refused
 * until a deploy fixes it, so `misconfigured` outranks a call that failed after its retries.
 */
export function signerKeysResult(
  answers: ReadonlyArray<PromiseSettledResult<PublicKeysResult>>
): SignerKeysResult {
  const signers: SignerPublicKeys[] = [];
  const failures: Array<'misconfigured' | 'unavailable'> = [];
  for (const [signer, answer] of answers.entries()) {
    if (answer.status === 'rejected') {
      console.error(
        JSON.stringify({
          event: 'uts.signer_keys.signer_failed',
          signer,
          error: String(answer.reason),
        })
      );
      failures.push('unavailable');
    } else if (answer.value.status === 'misconfigured') {
      console.error(
        JSON.stringify({
          event: 'uts.signer_keys.signer_misconfigured',
          signer,
          reason: answer.value.reason,
        })
      );
      failures.push('misconfigured');
    } else {
      signers.push({ signer: answer.value.signer, keys: answer.value.keys });
    }
  }
  if (failures.includes('misconfigured')) return { status: 'misconfigured' };
  if (failures.length > 0) return { status: 'unavailable' };
  return { status: 'ok', signers };
}

/** Every signer's published keys, read from the 16 signer objects in parallel. */
async function readSignerKeys(env: Env, config: UtsConfig): Promise<SignerKeysResult> {
  return signerKeysResult(
    await Promise.allSettled(
      Array.from({ length: UTS_SIGNER_COUNT }, (_, signer) =>
        withDORetry(
          () => getSignerStub(env, config, signer),
          async (stub): Promise<PublicKeysResult> => await stub.publicKeys(),
          'uts.signer.publicKeys'
        )
      )
    )
  );
}

/**
 * The internal signer-keys route (`UTS_SIGNER_KEYS_PATH`). It runs in the mint Worker's fetch
 * handler, which placement runs next to the identity store's primary, so the 16 signer calls
 * start next to the signer objects in western Europe. It answers only the feed Worker of its own
 * environment: a service binding carries `props.caller`, and only a deploy in the account can set
 * props, so the check is deploy-level trust, as for the STS broker (design 6.4). A request
 * without that caller, from the internet or from another binding, gets the same 404 as an unknown
 * path. `test/repo` keeps every other config from binding the mint Worker.
 */
export async function signerKeysResponse(
  request: Request,
  env: Env,
  config: UtsConfig,
  props: unknown
): Promise<Response> {
  const caller = callerOf(props);
  if (caller !== FEED_DEPLOYMENTS[config.environment]) {
    if (caller !== null) {
      console.warn(JSON.stringify({ event: 'uts.signer_keys.refused', caller }));
    }
    return jsonResponse({ error: 'not_found' }, 404);
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  }
  const result = await readSignerKeys(env, config);
  return jsonResponse(result, SIGNER_KEYS_HTTP_STATUS[result.status]);
}
