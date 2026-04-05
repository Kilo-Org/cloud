import type { getSandbox } from '@cloudflare/sandbox';
import type { DeploymentArtifacts, DeploymentFile, ProjectType } from './types';
import { readFolderAsArchive } from './sandbox-file-reader';
import { ArtifactReadError } from './errors';
import staticWorkerContent from './assets/static.worker.js';

// Type for the sandbox stub returned by getSandbox()
type SandboxStub = Awaited<ReturnType<typeof getSandbox>>;

/**
 * Reads deployment artifacts from a Cloudflare Sandbox
 */
export class SandboxArtifactReader {
  /**
   * Read worker script and assets from sandbox using tar-based reading for better performance.
   * This method uses tar archives to efficiently transfer entire directory structures from the sandbox,
   * which is significantly faster than reading files individually.
   *
   * @param sandbox - Cloudflare Sandbox instance
   * @param bundledPath - Path to directory containing bundled files
   * @param entrypointFilename - Name of the entrypoint file (e.g., 'worker.js')
   * @param assetsPath - Path to assets directory in sandbox
   * @param logger - Optional callback for logging progress
   * @param batchSize - Batch size parameter (unused in tar-based implementation, kept for signature compatibility)
   * @returns Deployment artifacts ready for deployment
   */
  async readArtifacts(
    sandbox: SandboxStub,
    bundledPath: string,
    entrypointFilename: string,
    assetsPath: string,
    logger?: (message: string) => void
  ): Promise<DeploymentArtifacts> {
    const session = await sandbox.createSession();

    // Read bundled files as tar archive, excluding README.md and .map files
    if (logger) logger('Reading build output...');
    const bundledFiles = await readFolderAsArchive(session, bundledPath, ['README.md', '*.map']);

    let workerScript: DeploymentFile | null = null;
    const artifacts: DeploymentFile[] = [];

    // Process bundled files
    for (const fileEntry of bundledFiles) {
      const filename = fileEntry.path.split('/').pop() || '';

      // Check if this is the entrypoint file
      if (filename === entrypointFilename) {
        workerScript = fileEntry;
      } else {
        artifacts.push(fileEntry);
      }
    }

    if (!workerScript) {
      throw new Error('Build output is incomplete');
    }

    // Read assets as tar archive
    if (logger) logger('Reading assets...');
    const assetFiles = await readFolderAsArchive(session, assetsPath);

    return {
      workerScript,
      artifacts,
      assets: assetFiles,
    };
  }

  /**
   * Read artifacts from standard OpenNext output structure (Next.js)
   * @param sandbox - Cloudflare Sandbox instance
   * @param logger - Optional callback for logging progress
   * @returns Deployment artifacts
   */
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

  /**
   * Read assets from static site output structure.
   * Returns complete DeploymentArtifacts with the static worker script.
   * @param sandbox - Cloudflare Sandbox instance
   * @param logger - Optional callback for logging progress
   * @returns Deployment artifacts with assets and static worker script
   */
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

  /**
   * Read artifacts based on detected project type
   * @param sandbox - Cloudflare Sandbox instance
   * @param projectType - Detected project type
   * @param logger - Optional callback for logging progress
   * @returns Deployment artifacts
   */
  async readArtifactsByType(
    sandbox: SandboxStub,
    projectType: ProjectType,
    logger?: (message: string) => void
  ): Promise<DeploymentArtifacts> {
    if (projectType === 'nextjs') {
      return this.readOpenNextArtifacts(sandbox, logger);
    }
    // For static sites, return DeploymentArtifacts with static worker script
    return this.readStaticSiteAssets(sandbox);
  }
}
