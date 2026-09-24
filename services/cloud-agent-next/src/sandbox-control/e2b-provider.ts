import { E2BProviderError } from '../byoc/e2b-errors.js';
import type { E2BSandboxProviderBinding } from '../sandbox-provider-binding.js';
import type { E2BAllocationConfig, E2BSubmittedAllocationConfig } from '../sandbox-state/model/allocation.js';
import {
  createE2BSandbox,
  getE2BSandbox,
  killE2BSandbox,
  setE2BSandboxTimeout,
  validateE2BApiKey,
  E2B_MANAGEMENT_TIMEOUT_MS,
  type E2BSandboxDetail,
} from './e2b-api.js';
import { launchE2BWrapper } from './e2b-envd.js';
import { matchesE2BSandboxIntent, reconcileE2BCreate } from './e2b-reconciliation.js';
import {
  E2B_INITIAL_LEASE_MS,
  encodeE2BProviderRef,
  markE2BConfigSubmitted,
  parseE2BProviderRef,
  parseOwnedE2BConfig,
} from './e2b-runtime.js';
import type { ProviderAdapter } from './provider.js';

const LEASE_MARGIN_MS = E2B_MANAGEMENT_TIMEOUT_MS + 1000;

function freezeConfig<T extends E2BAllocationConfig>(config: T): T {
  Object.freeze(config.binding);
  Object.freeze(config.resourceProfile);
  return Object.freeze(config);
}

/**
 * The E2B provider adapter. Built per operation from the persisted submitted
 * target; the API key is resolved per call and never cached on the instance.
 * `create` is the only caller that receives the submission callback: the
 * callback dispatches `CREATE_SUBMISSION_RECORDED` inside a storage transaction
 * and returns the submitted block, which this adapter compares against its own
 * computation before POSTing.
 */
export function createE2BControlAdapter(deps: {
  config: E2BAllocationConfig;
  binding: E2BSandboxProviderBinding;
  sandboxId: string;
  intentId: string;
  resolveApiKey: (binding: E2BSandboxProviderBinding) => Promise<string>;
  submitCreateIntent?: () => Promise<E2BSubmittedAllocationConfig>;
}): ProviderAdapter {
  // Copy the binding so a caller mutating its own object cannot change the
  // identity this adapter resolves credentials against.
  const binding: E2BSandboxProviderBinding = Object.freeze({ ...deps.binding });
  let pinned = freezeConfig(parseOwnedE2BConfig(deps.config, binding, deps.sandboxId));
  const intentId = deps.intentId;
  const resolveApiKey = deps.resolveApiKey;
  const submitCreateIntent = deps.submitCreateIntent;
  let createAttempted = false;

  function validateIntent(intent: { e2b?: E2BAllocationConfig } | null | undefined): void {
    if (intent === undefined || intent === null) return;
    if (intent.e2b === undefined) throw new E2BProviderError('byoc_e2b_policy_mismatch');
    const candidate = parseOwnedE2BConfig(intent.e2b, binding, deps.sandboxId);
    if (JSON.stringify(candidate) !== JSON.stringify(pinned)) {
      throw new E2BProviderError('byoc_e2b_policy_mismatch');
    }
  }

  function ownedRef(ref: string) {
    const parsed = parseE2BProviderRef(ref);
    if (
      !parsed ||
      parsed.intentId !== intentId ||
      pinned.submissionState !== 'submitted'
    ) {
      throw new E2BProviderError('byoc_e2b_policy_mismatch');
    }
    return parsed;
  }

  async function currentApiKey(): Promise<string> {
    try {
      const apiKey = await resolveApiKey({ ...binding });
      validateE2BApiKey(apiKey);
      return apiKey;
    } catch (error) {
      throw new E2BProviderError(
        error instanceof E2BProviderError ? error.code : 'byoc_e2b_unavailable'
      );
    }
  }

  function requireLifetime(ms = 0): void {
    if (pinned.hardStopAt - Date.now() <= ms) {
      throw new E2BProviderError('byoc_e2b_lifetime_exceeded');
    }
  }

  function requireOwned(info: E2BSandboxDetail, physicalId: string): void {
    if (info.sandboxID !== physicalId || !matchesE2BSandboxIntent(info, pinned, intentId)) {
      throw new E2BProviderError('byoc_e2b_policy_mismatch');
    }
  }

  async function runningSandbox(
    apiKey: string,
    physicalId: string,
    deadlineAt?: number
  ): Promise<E2BSandboxDetail> {
    const info = await getE2BSandbox(apiKey, physicalId, deadlineAt);
    if (!info) throw new E2BProviderError('byoc_e2b_unavailable');
    requireOwned(info, physicalId);
    if (info.state !== 'running') throw new E2BProviderError('byoc_e2b_bootstrap_failed');
    if (
      info.lifecycle?.onTimeout !== 'kill' ||
      info.lifecycle.autoResume !== false ||
      info.network?.allowPublicTraffic !== false ||
      !info.envdAccessToken
    ) {
      throw new E2BProviderError('byoc_e2b_policy_mismatch');
    }
    return info;
  }

  async function safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new E2BProviderError(
        error instanceof E2BProviderError ? error.code : 'byoc_e2b_unavailable'
      );
    }
  }

  return {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission(ref, billing) {
      ownedRef(ref);
      await currentApiKey();
      if (billing?.enforcementRequested) throw new E2BProviderError('byoc_e2b_policy_mismatch');
    },
    async create(intent) {
      validateIntent(intent);
      if (
        (pinned.submissionState === 'pending' && !submitCreateIntent) ||
        intent.networkPolicy !== undefined ||
        intent.billing?.enforcementRequested
      ) {
        throw new E2BProviderError('byoc_e2b_policy_mismatch');
      }
      if (createAttempted || pinned.submissionState === 'submitted') {
        throw new E2BProviderError('byoc_e2b_create_unknown');
      }
      createAttempted = true;
      const apiKey = await currentApiKey();
      requireLifetime(E2B_INITIAL_LEASE_MS + LEASE_MARGIN_MS);
      if (submitCreateIntent) {
        const submitted = await submitCreateIntent();
        const expected = markE2BConfigSubmitted({
          config: pinned,
          binding,
          sandboxId: deps.sandboxId,
          now: submitted.submittedAt,
          createDeadlineAt: submitted.createDeadlineAt,
        });
        if (JSON.stringify(expected) !== JSON.stringify(submitted)) {
          throw new E2BProviderError('byoc_e2b_policy_mismatch');
        }
        pinned = freezeConfig(submitted);
      }
      if (
        pinned.submissionState !== 'submitted' ||
        Date.now() < pinned.submittedAt ||
        Date.now() >= pinned.createDeadlineAt ||
        Date.now() >= pinned.reconciliationDeadlineAt
      ) {
        throw new E2BProviderError('byoc_e2b_create_unknown');
      }
      try {
        const created = await createE2BSandbox(apiKey, pinned, intentId);
        if (created.templateID === pinned.templateId) {
          return {
            providerRef: encodeE2BProviderRef({ physicalId: created.sandboxID, intentId }),
          };
        }
      } catch (error) {
        if (
          error instanceof E2BProviderError &&
          (error.code === 'byoc_e2b_credential_invalid' ||
            error.code === 'byoc_e2b_template_unavailable' ||
            error.code === 'byoc_e2b_capacity')
        ) {
          throw new E2BProviderError(error.code);
        }
      }
      const found = await reconcileE2BCreate(apiKey, pinned, intentId);
      return found
        ? { providerRef: encodeE2BProviderRef({ physicalId: found.sandboxID, intentId }) }
        : { unresolved: true };
    },
    async launch(ref, env) {
      await safely(async () => {
        const { physicalId } = ownedRef(ref);
        const apiKey = await currentApiKey();
        requireLifetime();
        const deadlineAt = pinned.submissionState === 'submitted' ? pinned.createDeadlineAt : 0;
        if (Date.now() >= deadlineAt) throw new E2BProviderError('byoc_e2b_bootstrap_failed');
        const sandbox = await runningSandbox(apiKey, physicalId, deadlineAt);
        await launchE2BWrapper({
          apiKey,
          sandbox,
          providerRef: ref,
          runtimeBuildId: pinned.runtimeBuildId,
          env,
          deadlineAt,
        });
      });
    },
    async observe(ref, intent) {
      try {
        validateIntent(intent);
        const parsed = ref === null ? null : ownedRef(ref);
        // A validated pending block with no reference never reached the network:
        // settle it before resolving a credential. A malformed identity threw in
        // `validateIntent`/`ownedRef` and does not take this branch.
        if (parsed === null && pinned.submissionState === 'pending') return { status: 'terminal' };
        const apiKey = await currentApiKey();
        if (parsed) {
          const info = await getE2BSandbox(apiKey, parsed.physicalId);
          if (!info) return { status: 'terminal' };
          requireOwned(info, parsed.physicalId);
          return { status: info.state === 'running' ? 'active' : 'unknown' };
        }
        const found = await reconcileE2BCreate(apiKey, pinned, intentId);
        return found
          ? {
              status: found.state === 'running' ? 'active' : 'unknown',
              providerRef: encodeE2BProviderRef({ physicalId: found.sandboxID, intentId }),
            }
          : { status: 'unknown' };
      } catch {
        return { status: 'unknown' };
      }
    },
    async stop(ref, intent) {
      try {
        validateIntent(intent);
        let parsed = ref === null ? null : ownedRef(ref);
        if (parsed === null && pinned.submissionState === 'pending') return 'terminal';
        const apiKey = await currentApiKey();
        if (!parsed) {
          const found = await reconcileE2BCreate(apiKey, pinned, intentId);
          if (!found) return 'retryable';
          parsed = { physicalId: found.sandboxID, intentId };
        }
        const info = await getE2BSandbox(apiKey, parsed.physicalId);
        if (!info) return 'terminal';
        requireOwned(info, parsed.physicalId);
        await killE2BSandbox(apiKey, parsed.physicalId);
        return 'terminal';
      } catch {
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      await safely(async () => {
        const { physicalId } = ownedRef(ref);
        if (!Number.isSafeInteger(ms) || ms <= 0) {
          throw new E2BProviderError('byoc_e2b_policy_mismatch');
        }
        requireLifetime(ms + 1000);
        const apiKey = await currentApiKey();
        const info = await runningSandbox(apiKey, physicalId);
        requireLifetime(ms + 1000);
        const endAt = Date.parse(info.endAt);
        if (endAt <= pinned.hardStopAt && endAt - Date.now() >= ms + 1000) return;
        const timeoutSeconds = Math.ceil((ms + LEASE_MARGIN_MS) / 1000);
        requireLifetime(timeoutSeconds * 1000 + LEASE_MARGIN_MS);
        await setE2BSandboxTimeout(apiKey, physicalId, timeoutSeconds);
        const renewed = await runningSandbox(apiKey, physicalId);
        const renewedEndAt = Date.parse(renewed.endAt);
        requireLifetime(ms);
        if (renewedEndAt > pinned.hardStopAt) {
          throw new E2BProviderError('byoc_e2b_lifetime_exceeded');
        }
        if (renewedEndAt - Date.now() < ms) throw new E2BProviderError('byoc_e2b_unavailable');
      });
    },
    async logs(ref) {
      ownedRef(ref);
      await currentApiKey();
      return 'E2B guest logs are withheld because they may contain credentials.';
    },
  };
}
