import {
  GithubRunAttestationResultSchema,
  type AttestedGithubRun,
  type GithubRunAttestationRequest,
  type GithubRunAttestationResult,
} from '@kilocode/sts-contracts';
import type { DeniedReason } from './api';
import { ALLOWED_EVENTS, REPOSITORY, expectedRun, type ProxyConfig } from './config';

/**
 * Contract §5 steps 1-2: STS verifies the GitHub job's token with the proxy's own audience and
 * returns the attested claims; the proxy then re-checks them against constants derived from
 * `config.environment`. The proxy mints nothing and never verifies a token itself.
 */

/** The part of the STS binding the proxy calls besides `getBundle`. */
export type AttestBinding = {
  attestGithubRun(request: GithubRunAttestationRequest): Promise<GithubRunAttestationResult>;
};

export type Attested = { workload: string; github: AttestedGithubRun };

export type AttestOutcome =
  | { kind: 'ok'; attested: Attested }
  | { kind: 'identity_rejected' }
  | { kind: 'denied'; reason: DeniedReason; attested: Attested | null }
  | { kind: 'unavailable'; retryAfterSeconds: number };

const STS_RETRY_SECONDS = 30;

/** Steps 1 and 2 in order; the first failure answers. */
export async function attestRun(
  sts: AttestBinding,
  token: string,
  config: ProxyConfig
): Promise<AttestOutcome> {
  let raw: unknown;
  try {
    raw = await sts.attestGithubRun({ token });
    // workerd keeps an RPC call open until its result is disposed; the result is plain data.
    (raw as Partial<Disposable>)[Symbol.dispose]?.();
  } catch {
    return { kind: 'unavailable', retryAfterSeconds: STS_RETRY_SECONDS };
  }
  const result = GithubRunAttestationResultSchema.safeParse(raw);
  if (!result.success) return { kind: 'unavailable', retryAfterSeconds: STS_RETRY_SECONDS };
  const answer = result.data;
  if (answer.status === 'unavailable') {
    return { kind: 'unavailable', retryAfterSeconds: answer.retryAfterSeconds };
  }
  if (answer.status === 'denied') {
    if (answer.reason === 'identity_rejected') return { kind: 'identity_rejected' };
    return { kind: 'denied', reason: answer.reason, attested: null };
  }
  const attested = { workload: answer.workload, github: answer.github };
  if (claimsMismatch(attested, config)) {
    return { kind: 'denied', reason: 'claim_mismatch', attested };
  }
  return { kind: 'ok', attested };
}

/** §5 step 2: any difference from this deployment's expected identity is `claim_mismatch`. */
export function claimsMismatch(attested: Attested, config: ProxyConfig): boolean {
  const expected = expectedRun(config.environment);
  const { github } = attested;
  return (
    github.repositoryId !== REPOSITORY.id ||
    github.repositoryOwnerId !== REPOSITORY.ownerId ||
    github.ref !== 'refs/heads/main' ||
    github.environment !== expected.environment ||
    github.jobWorkflowRef !== expected.jobWorkflowRef ||
    !ALLOWED_EVENTS.includes(github.eventName) ||
    attested.workload !== expected.workload
  );
}
