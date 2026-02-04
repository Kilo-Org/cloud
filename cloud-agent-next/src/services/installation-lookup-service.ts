import { createDatabaseConnection } from '../db/database.js';
import { PlatformIntegrationsStore } from '../db/stores/PlatformIntegrationsStore.js';

type InstallationLookupEnv = {
  HYPERDRIVE?: { connectionString: string };
};

type LookupParams = {
  githubRepo: string;
  userId: string;
  orgId?: string;
};

type LookupResult = {
  installationId: string;
  accountLogin: string;
  githubAppType: 'standard' | 'lite';
} | null;

export class InstallationLookupService {
  private store: PlatformIntegrationsStore | null = null;

  constructor(private env: InstallationLookupEnv) {}

  isConfigured(): boolean {
    return Boolean(this.env.HYPERDRIVE);
  }

  private getStore(): PlatformIntegrationsStore {
    if (!this.store) {
      if (!this.env.HYPERDRIVE) {
        throw new Error('Hyperdrive not configured');
      }
      const db = createDatabaseConnection(this.env.HYPERDRIVE.connectionString);
      this.store = new PlatformIntegrationsStore(db);
    }
    return this.store;
  }

  async findInstallationId(params: LookupParams): Promise<LookupResult> {
    if (!this.isConfigured()) {
      return null;
    }

    const [repoOwner] = params.githubRepo.split('/');
    const store = this.getStore();

    const result = await store.findGitHubInstallation({
      repoOwner,
      userId: params.userId,
      orgId: params.orgId,
    });

    if (!result) {
      return null;
    }

    return {
      installationId: result.platform_installation_id,
      accountLogin: result.platform_account_login,
      githubAppType: result.github_app_type || 'standard',
    };
  }
}
