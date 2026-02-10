import type { Sandbox } from '@cloudflare/sandbox';
import type { Env, DbCredentials } from './types';
import { logger, withLogTags, formatError } from './utils/logger';

export const DBProvisionResult = {
  NO_DB: 'NO_DB',
  PROVISIONED: 'PROVISIONED',
  MIGRATED: 'MIGRATED',
} as const;

export type DBProvisionResult = (typeof DBProvisionResult)[keyof typeof DBProvisionResult];

type DBProvisionerDeps = {
  env: Pick<Env, 'DB_PROXY' | 'DB_PROXY_URL'>;
  getCredentials: () => DbCredentials | null;
  setCredentials: (creds: DbCredentials) => Promise<void>;
};

export function createDBProvisioner(deps: DBProvisionerDeps) {
  async function needsDB(sandbox: Sandbox): Promise<boolean> {
    const result = await sandbox.readFile('/workspace/package.json');
    if (!result.success) {
      logger.debug('needsDB: package.json not found');
      return false;
    }
    try {
      const pkg = JSON.parse(result.content);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const found = '@kilocode/app-builder-db' in allDeps;
      logger.debug(found ? 'needsDB: dependency found' : 'needsDB: dependency not in package.json');
      return found;
    } catch (error) {
      logger.warn('needsDB: failed to parse package.json', formatError(error));
      return false;
    }
  }

  async function provisionDB(appId: string): Promise<void> {
    logger.info('Provisioning database');
    const start = Date.now();
    const { token } = await deps.env.DB_PROXY.provision(appId);
    const url = deps.env.DB_PROXY_URL + '/api/' + appId + '/query';
    await deps.setCredentials({ url, token });
    logger.info('Database provisioned', { durationMs: Date.now() - start });
  }

  async function runMigrations(sandbox: Sandbox): Promise<void> {
    logger.info('Running migrations');
    const dbCreds = deps.getCredentials();
    if (!dbCreds) {
      logger.warn('Skipping migrations: missing db credentials');
      return;
    }

    const start = Date.now();
    const result = await sandbox.exec('cd /workspace && bun run db:migrate', {
      env: { DB_URL: dbCreds.url, DB_TOKEN: dbCreds.token },
    });
    const durationMs = Date.now() - start;

    if (!result.success) {
      logger.error('Migration failed', {
        durationMs,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      });
      throw new Error(`Migration failed: ${result.stderr || 'Unknown error'}`);
    }
    logger.info('Migrations completed', { durationMs });
  }

  async function provisionIfNeeded(sandbox: Sandbox, appId: string): Promise<DBProvisionResult> {
    return withLogTags({ source: 'DBProvisioner' }, async () => {
      const start = Date.now();
      try {
        if (!(await needsDB(sandbox))) {
          logger.info('DB provisioning: no database needed', {
            result: DBProvisionResult.NO_DB,
            durationMs: Date.now() - start,
          });
          return DBProvisionResult.NO_DB;
        }

        const needsProvisioning = !deps.getCredentials();
        if (needsProvisioning) {
          await provisionDB(appId);
        }

        await runMigrations(sandbox);
        const result = needsProvisioning
          ? DBProvisionResult.PROVISIONED
          : DBProvisionResult.MIGRATED;
        logger.info('DB provisioning completed', { result, durationMs: Date.now() - start });
        return result;
      } catch (error) {
        logger.error('DB provisioning failed', {
          durationMs: Date.now() - start,
          ...formatError(error),
        });
        throw error;
      }
    });
  }

  return { provisionIfNeeded };
}

export type DBProvisioner = ReturnType<typeof createDBProvisioner>;
