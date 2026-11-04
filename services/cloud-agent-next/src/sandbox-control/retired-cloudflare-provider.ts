import type {
  ProviderAdapter,
  ProviderCreateIntent,
  ProviderObservation,
  ProviderStartupCommand,
  ProviderLaunchOptions,
  ProviderLaunchResult,
  StopResult,
} from './provider.js';

export const RETIRED_CLOUDFLARE_RUNTIME_MESSAGE =
  'The legacy Cloudflare Sandbox runtime has been retired. This session cannot start compute.';

type RetiredOperation = 'create' | 'launch' | 'admission';

export class RetiredSandboxProviderError extends Error {
  constructor(operation: RetiredOperation) {
    super(`${RETIRED_CLOUDFLARE_RUNTIME_MESSAGE} (${operation})`);
    this.name = 'RetiredSandboxProviderError';
  }
}

/**
 * Read-only adapter for a persisted legacy Cloudflare Sandbox pin. Status,
 * release and deletion still see a terminal runtime, but no operation can
 * create, launch or admit compute on the retired runtime.
 */
export function createRetiredCloudflareProviderAdapter(): ProviderAdapter {
  return {
    async ensureBillingAdmission() {
      throw new RetiredSandboxProviderError('admission');
    },
    async create(_intent: ProviderCreateIntent) {
      throw new RetiredSandboxProviderError('create');
    },
    async launch(
      _ref: string,
      _startup: { command: ProviderStartupCommand; env: Record<string, string> },
      _options?: ProviderLaunchOptions
    ): Promise<ProviderLaunchResult> {
      throw new RetiredSandboxProviderError('launch');
    },
    async observe(ref): Promise<ProviderObservation> {
      return { status: 'terminal', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(): Promise<StopResult> {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs(ref): Promise<string> {
      return `cloudflare ${ref} (retired)`;
    },
  };
}
