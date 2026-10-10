import type { getSandbox } from '@cloudflare/sandbox';
import type { DeploymentArtifacts, DeploymentFile, ProjectType } from './types';
import { readFolderAsArchive } from './sandbox-file-reader';
import { ArtifactReadError } from './errors';
import staticWorkerContent from './assets/static.worker.js';

type SandboxStub = Awaited<ReturnType<typeof getSandbox>>;

export class SandboxArtifactReader {
  /**
   * Read worker script and assets from sandbox using tar-based reading for better performance.
   * This method uses tar archives to efficiently transfer entire directory structures from the sandbox,
   * which is significantly faster than reading files individually.
   */
  async readArtifacts(
    sandbox: SandboxStub,
    bundledPath: string,
    entrypointFilename: string,
    assetsPath: string,
    logger?: (message: string) => void
  ): Promise<DeploymentArtifacts> {
    const session = await sandbox.createSession();

    if (logger) logger('Reading build output...');
    const bundledFiles = await readFolderAsArchive(session, bundledPath, ['README.md', '*.map']);

    let workerScript: DeploymentFile | null = null;
    const artifacts: DeploymentFile[] = [];

    for (const fileEntry of bundledFiles) {
      const filename = fileEntry.path.split('/').pop() || '';

      if (filename === entrypointFilename) {
        workerScript = fileEntry;
      } else {
        artifacts.push(fileEntry);
      }
    }

    if (!workerScript) {
      throw new Error('Build output is incomplete');
    }

    if (logger) logger('Reading assets...');
    const assetFiles = await readFolderAsArchive(session, assetsPath);

    return {
      workerScript,
      artifacts,
      assets: assetFiles,
    };
  }

  async readOpenNextArtifacts(
    sandbox: SandboxStub,
    logger?: (message: string) => void
  ): Promise<DeploymentArtifacts> {
    const bundledPath = '/workspace/project/.bundled-app';
    const entrypointFilename = 'worker.js';
    const assetsPath = '/workspace/project/.open-next/assets';

    try {
      return this.readArtifacts(sandbox, bundledPath, entrypointFilename, assetsPath, logger);
    } catch (error) {
      throw new ArtifactReadError('Failed to read artifacts', error);
    }
  }

  async readStaticSiteAssets(sandbox: SandboxStub): Promise<DeploymentArtifacts> {
    const assetsPath = '/workspace/project/.static-site/assets';
    const session = await sandbox.createSession();

    const assetFiles = await readFolderAsArchive(session, assetsPath);

    // Return complete DeploymentArtifacts with static worker script (imported as text via wrangler rules)
    return {
      workerScript: {
        path: 'index.js',
        content: Buffer.from(staticWorkerContent, 'utf-8'),
        mimeType: 'application/javascript+module',
      },
      artifacts: [],
      assets: assetFiles,
    };
  }

  async readArtifactsByType(
    sandbox: SandboxStub,
    projectType: ProjectType,
    logger?: (message: string) => void
  ): Promise<DeploymentArtifacts> {
    if (projectType === 'nextjs') {
      return this.readOpenNextArtifacts(sandbox, logger);
    }
    return this.readStaticSiteAssets(sandbox);
  }
}
