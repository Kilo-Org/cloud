import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * The local e2e's stand-in for STS's SecretsBroker (contract §10 step 5). A token
 * `<sha>:<runId>:<attempt>` attests a staging db-gate run at that sha (the identity the
 * development stack expects); the bundle serves the login's password and the App key from vars.
 */
type FakeStsEnv = { FAKE_DB_PASSWORD: string; FAKE_APP_KEY: string };

export class SecretsBroker extends WorkerEntrypoint<FakeStsEnv> {
  async attestGithubRun({ token }: { token: string }) {
    const [sha, runId, runAttempt] = token.split(':');
    if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    return {
      status: 'ok',
      workload: 'ci-db-migrate-staging',
      github: {
        repositoryId: '1145038391',
        repositoryOwnerId: '201822503',
        environment: 'staging',
        ref: 'refs/heads/main',
        sha,
        eventName: 'workflow_dispatch',
        jobWorkflowRef: 'Kilo-Org/cloud/.github/workflows/deploy-staging.yml@refs/heads/main',
        runId: runId ?? '1',
        runAttempt: runAttempt ?? '1',
      },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async getBundle() {
    return {
      status: 'ok',
      workload: 'migration-proxy',
      environment: 'development',
      etag: '"e2e-0123456789abcdef"',
      stale: false,
      fetchedAt: new Date().toISOString(),
      secrets: {
        MIGRATION_PROXY_DB_PASSWORD: { value: this.env.FAKE_DB_PASSWORD, version: 1 },
        MIGRATION_PROXY_GITHUB_APP_KEY: { value: this.env.FAKE_APP_KEY, version: 1 },
      },
      missing: [],
    };
  }
}

export default {
  async fetch() {
    return new Response('fake sts');
  },
};
