import { DurableObject } from 'cloudflare:workers';
import { type ExecEvent, getSandbox, parseSSEStream } from '@cloudflare/sandbox';
import { stripVTControlCharacters } from 'node:util';
import type {
  Env,
  Event,
  Build,
  BuildStatus,
  StatusResponse,
  ProjectType,
  ArchiveDeployParams,
  GitSource,
  CancelBuildResult,
} from './types';
import { supportedProjectTypeSchema } from './types';
import { Deployer } from './deployer';
import { SandboxArtifactReader } from './sandbox-artifact-reader';
import { CloudflareAPI } from './cloudflare-api';
import type { EventsManager } from './events-manager';
import type {
  EncryptedEnvVar,
  PlaintextEnvVar,
} from '../../../../apps/web/src/lib/user-deployments/env-vars-validation';
import decryptEnvVars from './env-decryptor';
import * as Sentry from '@sentry/cloudflare';
import {
  ArchiveExtractionError,
  BuildStepError,
  GitCloneError,
  GitLfsError,
  ProjectDetectionError,
} from './errors';
import { sanitizeGitError } from './sanitize-git-error';

export class DeploymentOrchestrator extends DurableObject<Env> {
  private state!: Build;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async alarm(): Promise<void> {
    await this.loadState();

    if (this.state.status === 'queued') {
      await this.run();
    }
  }

  private async loadState(): Promise<void> {
    const storedState = await this.ctx.storage.get<Build>('state');

    if (storedState) {
      this.state = storedState;
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

  private eventsManager(): DurableObjectStub<EventsManager> {
    const eventsManagerId = this.env.EventsManager.idFromName(this.state.buildId);
    return this.env.EventsManager.get(eventsManagerId);
  }

  private async addLogEvent(message: string): Promise<void> {
    const eventsManager = this.eventsManager();
    await eventsManager.addEvent({ type: 'log', payload: { message } });
  }

  private async addStatusChangeEvent(status: BuildStatus): Promise<void> {
    const eventsManager = this.eventsManager();

    await eventsManager.addEvent({
      type: 'status_change',
      payload: { status },
    });
  }

  private async logExecResult(result: { stdout: string; stderr: string }): Promise<void> {
    for (const output of [result.stderr, result.stdout]) {
      for (const line of output.split('\n')) {
        if (line.trim() !== '') {
          await this.addLogEvent(line);
        }
      }
    }
  }

  private async updateStatus(status: BuildStatus): Promise<void> {
    if (this.state.status === status) {
      return;
    }

    this.state.status = status;

    if (status === 'building' && !this.state.startedAt) {
      this.state.startedAt = new Date().toISOString();
    }

    if (status === 'deployed' || status === 'failed') {
      this.state.completedAt = new Date().toISOString();
    }

    this.state.updatedAt = new Date().toISOString();
    await this.saveState();

    await this.addStatusChangeEvent(status);
  }

  async start(params: {
    buildId: string;
    slug: string;
    source: GitSource;
    envVars?: EncryptedEnvVar[];
  }): Promise<{ status: BuildStatus }> {
    this.state = {
      buildId: params.buildId,
      slug: params.slug,
      source: params.source,
      envVars: params.envVars,
      status: 'queued',
      updatedAt: new Date().toISOString(),
    };
    await this.saveState();

    const eventsManager = this.eventsManager();
    await eventsManager.initialize(this.state.buildId);

    await this.addLogEvent('Build created and queued');

    // Alarms are designed for long-running work that survives context timeouts
    await this.ctx.storage.setAlarm(Date.now() + 50);

    return { status: this.state.status };
  }

  async startFromArchive(params: ArchiveDeployParams): Promise<{ status: BuildStatus }> {
    this.state = {
      buildId: params.buildId,
      slug: params.slug,
      source: { type: 'archive' },
      envVars: params.envVars,
      status: 'queued',
      updatedAt: new Date().toISOString(),
    };

    // Store archive buffer temporarily (will be cleared after extraction)
    await this.ctx.storage.put('archiveBuffer', params.archiveBuffer);
    await this.saveState();

    const eventsManager = this.eventsManager();
    await eventsManager.initialize(this.state.buildId);

    await this.addLogEvent('Build created from archive');

    await this.ctx.storage.setAlarm(Date.now() + 50);

    return { status: this.state.status };
  }

  async status(): Promise<StatusResponse> {
    if (!this.state) {
      await this.loadState();
    }

    if (!this.state) {
      throw new Error('Build not found');
    }

    return this.state;
  }

  async events(): Promise<Event[]> {
    if (!this.state) {
      await this.loadState();
    }

    if (!this.state) {
      throw new Error('Build not found');
    }

    const eventsManagerId = this.env.EventsManager.idFromName(this.state.buildId);
    const eventsManager = this.env.EventsManager.get(eventsManagerId);

    return eventsManager.getEvents();
  }

  async cancel(reason?: string): Promise<CancelBuildResult> {
    await this.loadState();

    if (!this.state) {
      return {
        cancelled: false,
        reason: 'not_found',
      };
    }

    const cancellableStatuses: BuildStatus[] = ['queued', 'building'];
    if (!cancellableStatuses.includes(this.state.status)) {
      return {
        cancelled: false,
        reason: 'already_finished',
        status: this.state.status,
      };
    }

    const sandbox = getSandbox(this.env.Sandbox, this.state.buildId);
    try {
      await sandbox.destroy();
      await this.addLogEvent('Build cancelled');
    } catch (error) {
      Sentry.captureException(error, {
        level: 'warning',
        tags: { source: 'deploy-cancel-cleanup' },
        extra: { slug: this.state.slug, buildId: this.state.buildId },
      });
      // Intentionally ignore errors during sandbox cleanup
    }

    if (reason) {
      await this.addLogEvent('Build cancelled with reason: ' + reason);
    }
    await this.updateStatus('cancelled');

    return {
      cancelled: true,
      reason: 'cancelled',
    };
  }

  private async setupArchiveSource(sandbox: Awaited<ReturnType<typeof getSandbox>>): Promise<void> {
    const archiveBuffer = await this.ctx.storage.get<Uint8Array>('archiveBuffer');
    if (!archiveBuffer) {
      throw new Error('Archive buffer not found in storage');
    }

    await this.ctx.storage.delete('archiveBuffer');

    await this.addLogEvent('Extracting archive...');

    const base64Archive = Buffer.from(archiveBuffer).toString('base64');

    await sandbox.writeFile('/tmp/project.tar.gz.b64', base64Archive);
    const decodeResult = await sandbox.exec(
      'base64 -d /tmp/project.tar.gz.b64 > /tmp/project.tar.gz && rm /tmp/project.tar.gz.b64'
    );

    if (!decodeResult.success) {
      throw new ArchiveExtractionError(
        `Failed to decode archive: ${decodeResult.stderr}`,
        new Error(decodeResult.stderr)
      );
    }

    await sandbox.exec('mkdir -p /workspace/project');
    const extractResult = await sandbox.exec('tar -xzf /tmp/project.tar.gz -C /workspace/project');

    if (!extractResult.success) {
      throw new ArchiveExtractionError(
        `Failed to extract archive: ${extractResult.stderr}`,
        new Error(extractResult.stderr)
      );
    }

    await sandbox.exec('rm /tmp/project.tar.gz');

    await this.addLogEvent('Archive extracted successfully');
  }

  private async setupGitSource(
    sandbox: Awaited<ReturnType<typeof getSandbox>>,
    source: GitSource,
    accessToken: string | undefined
  ): Promise<void> {
    let cloneUrl: string =
      source.provider === 'github' ? `https://github.com/${source.repoSource}` : source.repoSource;

    if (accessToken) {
      const url = new URL(cloneUrl);
      url.username = 'x-access-token';
      url.password = accessToken;
      cloneUrl = url.toString();
    }

    const checkoutOptions: { targetDir: string; branch?: string } = {
      targetDir: '/workspace/project',
    };

    if (source.branch) {
      checkoutOptions.branch = source.branch;
    }

    try {
      await sandbox.gitCheckout(cloneUrl, checkoutOptions);
    } catch (error) {
      // Hide error message from logs because it may show an access token
      await this.addLogEvent(`Failed to clone repository ${source.repoSource}`);
      // Sanitize error to remove any access tokens before sending to Sentry
      const sanitizedError = sanitizeGitError(error, accessToken);
      throw new GitCloneError(
        `Failed to clone repository ${source.repoSource}`,
        source.repoSource,
        sanitizedError
      );
    }

    const lfsCheckResult = await sandbox.exec(
      'cd /workspace/project && [ -f .gitattributes ] && grep -q "filter=lfs" .gitattributes'
    );
    // exitCode 0: LFS patterns found
    // exitCode 1: File doesn't exist or no LFS patterns
    // exitCode > 1: Actual error (e.g., permission denied)
    if (lfsCheckResult.exitCode > 1) {
      await this.addLogEvent('Warning: Failed to check for Git LFS');
    }
    const needsLfs = lfsCheckResult.exitCode === 0;

    if (needsLfs) {
      await this.addLogEvent('Git LFS detected, initializing...');
      const lfsResult = await sandbox.exec(
        'cd /workspace/project && git lfs install && git lfs pull'
      );
      if (lfsResult.success) {
        await this.addLogEvent('Git LFS initialized and files pulled successfully');
      } else {
        await this.addLogEvent('Git LFS initialization failed');
        await this.addLogEvent(lfsResult.stderr);
        throw new GitLfsError(
          'Failed to initialize Git LFS for repository that requires it',
          new Error(lfsResult.stderr)
        );
      }
    }

    const commitHashResult = await sandbox.exec('cd /workspace/project && git rev-parse HEAD');
    if (!commitHashResult.success) {
      console.log(commitHashResult.stderr);
    }
    const commitHash = commitHashResult.stdout.trim();

    await this.addLogEvent(`Repository cloned successfully (commit: ${commitHash})`);
  }

  private async popAccessTokenAndEnvData(): Promise<{
    accessToken?: string;
    envVars?: EncryptedEnvVar[];
  }> {
    const source = this.state.source;
    const envVars = this.state.envVars;
    const accessToken = source?.type === 'git' ? source.accessToken : undefined;

    let needsSave = false;

    if (source?.type === 'git' && source.accessToken) {
      this.state.source = { ...source, accessToken: undefined };
      needsSave = true;
    }
    if (envVars) {
      this.state.envVars = undefined;
      needsSave = true;
    }

    if (needsSave) {
      await this.saveState();
    }

    return { accessToken, envVars };
  }

  private async clearSensitiveDataOnFailure(): Promise<void> {
    // Clear archive buffer from storage (may not have been extracted yet)
    await this.ctx.storage.delete('archiveBuffer');

    let needsSave = false;

    if (this.state.source?.type === 'git' && this.state.source.accessToken) {
      this.state.source = { ...this.state.source, accessToken: undefined };
      needsSave = true;
    }

    if (this.state.envVars) {
      this.state.envVars = undefined;
      needsSave = true;
    }

    if (needsSave) {
      await this.saveState();
    }
  }

  private async needsMigrations(sandbox: Awaited<ReturnType<typeof getSandbox>>): Promise<boolean> {
    const result = await sandbox.exec('cat /workspace/project/package.json');
    if (!result.success) return false;
    try {
      const pkg = JSON.parse(result.stdout) as Record<string, unknown>;
      const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
      const devDeps = (pkg.devDependencies ?? {}) as Record<string, unknown>;
      const allDeps = { ...deps, ...devDeps };
      const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
      return '@kilocode/app-builder-db' in allDeps && 'db:migrate' in scripts;
    } catch {
      return false;
    }
  }

  private async runMigrations(
    sandbox: Awaited<ReturnType<typeof getSandbox>>,
    envVars: PlaintextEnvVar[]
  ): Promise<void> {
    await this.addLogEvent('Running database migrations...');
    await this.runScript(sandbox, 'bun run db:migrate', { cwd: '/workspace/project', envVars });
    await this.addLogEvent('Database migrations completed');
  }

  private async run(): Promise<void> {
    let sandbox: Awaited<ReturnType<typeof getSandbox>> | null = null;

    try {
      const source = this.state.source;
      if (!source) {
        throw new Error('No source configured for build');
      }

      const { accessToken, envVars } = await this.popAccessTokenAndEnvData();

      await this.updateStatus('building');

      sandbox = getSandbox(this.env.Sandbox, this.state.buildId);
      await this.addLogEvent('Build environment ready');

      if (source.type === 'archive') {
        await this.setupArchiveSource(sandbox);
      } else {
        await this.setupGitSource(sandbox, source, accessToken);
      }

      await this.addLogEvent('Analyzing project...');
      const detectResult = await sandbox.exec(
        'cd /workspace/project && /workspace/detect-project.sh /workspace/project'
      );
      if (!detectResult.success) {
        throw new ProjectDetectionError(
          'Failed to detect project type',
          undefined,
          new Error(detectResult.stderr || 'Detection script failed')
        );
      }

      const detectedType = detectResult.stdout.trim();

      await this.addLogEvent(`Detected: ${detectedType}`);

      const parseResult = supportedProjectTypeSchema.safeParse(detectedType);

      if (!parseResult.success) {
        if (detectedType === 'unknown') {
          throw new ProjectDetectionError(
            'Unable to detect project type. Please ensure your project has a valid package.json or index.html',
            detectedType
          );
        }
        throw new ProjectDetectionError(
          `Project type '${detectedType}' is not yet supported`,
          detectedType
        );
      }

      const projectType: ProjectType = parseResult.data;

      // TODO: Disabling this because it is somehow messing up with sandbox.exec
      // After this script is executed, any other scripts that return an error, will just hang indefinitely
      //
      // // Step 2: Set up tool versions (mise with .tool-versions support)
      // const setupResult = await sandbox.exec(
      //   'source /workspace/setup-versions.sh /workspace/project'
      // );
      // await this.logExecResult(setupResult);
      // if (!setupResult.success) {
      //   throw new Error('Failed to set up tool versions');
      // }

      const buildPipelines: Record<
        ProjectType,
        Array<{ message: string; script: string; passEnvVars?: boolean }>
      > = {
        nextjs: [
          {
            message: 'Installing dependencies...',
            script: '/workspace/install-deps.sh /workspace/project',
          },
          {
            message: 'Building application...',
            script: '/workspace/build-nextjs.sh /workspace/project /workspace/config',
            passEnvVars: true,
          },
          {
            message: 'Packaging build output...',
            script: '/workspace/package-nextjs.sh /workspace/project',
          },
        ],
        hugo: [
          {
            message: 'Building Hugo site...',
            script: '/workspace/build-hugo.sh /workspace/project',
            passEnvVars: true,
          },
        ],
        jekyll: [
          {
            message: 'Building Jekyll site...',
            script: '/workspace/build-jekyll.sh /workspace/project',
            passEnvVars: true,
          },
        ],
        eleventy: [
          {
            message: 'Building Eleventy site...',
            script: '/workspace/build-eleventy.sh /workspace/project',
            passEnvVars: true,
          },
        ],
        astro: [
          {
            message: 'Installing dependencies...',
            script: '/workspace/install-deps.sh /workspace/project',
          },
          {
            message: 'Building Astro site...',
            script: '/workspace/build-astro.sh /workspace/project',
            passEnvVars: true,
          },
        ],
        'plain-html': [
          {
            message: 'Packaging static assets...',
            script: '/workspace/build-static.sh /workspace/project',
          },
        ],
      };

      const decryptedEnvVars = decryptEnvVars(
        envVars || [],
        Buffer.from(this.env.ENV_ENCRYPTION_PRIVATE_KEY, 'base64')
      );

      for (const step of buildPipelines[projectType]) {
        await this.addLogEvent(step.message);
        await this.runScript(
          sandbox,
          step.script,
          step.passEnvVars ? { envVars: decryptedEnvVars } : undefined
        );
      }

      this.state.projectType = projectType;
      await this.saveState();

      await this.addLogEvent('Build completed successfully');

      if (await this.needsMigrations(sandbox)) {
        await this.runMigrations(sandbox, decryptedEnvVars);
      }

      await this.updateStatus('deploying');

      const artifactReader = new SandboxArtifactReader();
      const artifacts = await artifactReader.readArtifactsByType(
        sandbox,
        this.state.projectType || 'nextjs',
        (message: string) => this.addLogEvent(message)
      );

      const api = new CloudflareAPI(this.env.CLOUDFLARE_ACCOUNT_ID, this.env.CLOUDFLARE_API_TOKEN);
      const deployer = new Deployer(api);

      await deployer.deploy({
        artifacts,
        workerName: this.state.slug,
        logger: (message: string) => this.addLogEvent(message),
        envVars: decryptedEnvVars,
      });

      await this.updateStatus('deployed');
    } catch (error) {
      await this.updateStatus('failed');

      await this.clearSensitiveDataOnFailure();

      Sentry.captureException(error, {
        contexts: {
          build: {
            slug: this.state.slug,
          },
        },
        extra: {
          buildId: this.state.buildId,
        },
      });
    } finally {
      if (sandbox) {
        try {
          await sandbox.destroy();
          await this.addLogEvent('Build environment cleaned up');
        } catch (error) {
          Sentry.captureException(error, {
            level: 'warning',
            tags: { source: 'deploy-cleanup' },
            extra: { slug: this.state.slug, buildId: this.state.buildId },
          });
        }
      }
    }
  }

  private async runScript(
    sandbox: Awaited<ReturnType<typeof getSandbox>>,
    command: string,
    options?: { cwd?: string; envVars?: PlaintextEnvVar[] }
  ): Promise<void> {
    const env = options?.envVars
      ? Object.fromEntries(options.envVars.map(({ key, value }) => [key, value]))
      : undefined;
    const execOptions = env || options?.cwd ? { env, cwd: options?.cwd } : undefined;
    const stream = await sandbox.execStream(command, execOptions);

    for await (const event of parseSSEStream<ExecEvent>(stream)) {
      const data = stripVTControlCharacters(event.data || '').trim();

      if (data !== '') {
        await this.addLogEvent(data);
      }

      if (event.type === 'error') {
        throw new BuildStepError(
          event.error || 'Build step failed',
          command,
          event.error ? new Error(event.error) : undefined
        );
      }

      if (event.type === 'complete' && event.exitCode !== 0) {
        throw new BuildStepError(`Build step failed with exit code ${event.exitCode}`, command);
      }
    }
  }
}
