import type {
  SubjectOperation,
  SubjectOperationResult,
  SubjectRevocationRpc,
  UtsEnvironment,
} from '@kilocode/uts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { callerOf } from '../callers';
import { readConfig, type Env } from '../env';
import { subjectDeps } from './deps';
import { runSubjectOperation } from './operations';
import { NO_VERIFIER_RETRY_SECONDS } from './service-tokens';

/**
 * The Workers that may call `SubjectRevocation` (`UTS_SUBJECT_REVOCATION_ENTRYPOINT`), by the
 * deployed name their binding carries as `props.caller`, which UTS records as the workload in the
 * audit row. Only a deploy in the account can set props, so the check is deploy-level trust, as for
 * `PatLookup` (design 6.4); `test/repo` keeps every other config from binding the mint Worker. A
 * Worker joins its environment's list once its caller proof names it. Development lists the caller
 * the runtime tests use.
 */
export const SUBJECT_REVOCATION_CALLERS: Readonly<Record<UtsEnvironment, readonly string[]>> = {
  production: [],
  staging: [],
  development: ['uts-subjects-test'],
};

/**
 * The subject operations for Worker callers, over a service binding: the same bodies and outcomes
 * as `POST /internal/subjects/<op>` (src/subjects/routes.ts). Placement does not apply to a named
 * entrypoint, so the statement runs from where the caller runs, through the primary config. A
 * caller that is not listed, or an environment that binds no identity store, gets `unavailable`
 * with a 60-second retry, and nothing is written.
 */
export class SubjectRevocation extends WorkerEntrypoint<Env> implements SubjectRevocationRpc {
  async revokeSubject(request: unknown): Promise<SubjectOperationResult> {
    return await this.#run('revoke', request);
  }

  async unblockSubject(request: unknown): Promise<SubjectOperationResult> {
    return await this.#run('unblock', request);
  }

  async endBrowserSessions(request: unknown): Promise<SubjectOperationResult> {
    return await this.#run('end-browser-sessions', request);
  }

  async endDeviceSessions(request: unknown): Promise<SubjectOperationResult> {
    return await this.#run('end-device-sessions', request);
  }

  async revokeApiCredentials(request: unknown): Promise<SubjectOperationResult> {
    return await this.#run('revoke-api-credentials', request);
  }

  async #run(operation: SubjectOperation, request: unknown): Promise<SubjectOperationResult> {
    const config = readConfig(this.env);
    const caller = callerOf(this.ctx.props);
    if (caller === null || !SUBJECT_REVOCATION_CALLERS[config.environment].includes(caller)) {
      console.warn(JSON.stringify({ event: 'uts.subject_revocation.refused', caller, operation }));
      return { outcome: 'unavailable', retryAfterSeconds: NO_VERIFIER_RETRY_SECONDS };
    }
    const deps = subjectDeps(this.env, this.ctx, config);
    if (deps === null) {
      return { outcome: 'unavailable', retryAfterSeconds: NO_VERIFIER_RETRY_SECONDS };
    }
    return await runSubjectOperation(deps, operation, request, caller);
  }
}
