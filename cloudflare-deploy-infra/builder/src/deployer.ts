/**
 * Deployer - Orchestrates the deployment of Cloudflare Workers with assets.
 * Handles uploading assets and deploying worker scripts.
 */

import { WorkerNotFoundError, type CloudflareAPI } from './cloudflare-api';
import type { DeploymentArtifacts } from './types';
import { calculateSHA256, getByteSize, validateWorkerName } from './utils';
import type { PlaintextEnvVar } from '../../../src/lib/user-deployments/env-vars-validation';

export class Deployer {
  private api: CloudflareAPI;

  constructor(api: CloudflareAPI) {
    this.api = api;
  }

  /**
   * Create a minimal draft worker. Used when secrets need to be set on a non-existent worker.
   */
  private async createDraftWorker(workerName: string, dispatchNamespace: string): Promise<void> {
    const draftWorkerCode = 'export default { fetch() {} }';
    const draftWorkerBuffer = Buffer.from(draftWorkerCode, 'utf-8');

    await this.api.deployWorker({
      scriptName: workerName,
      metadata: {
        main_module: 'index.js',
        compatibility_date: '2025-09-01',
        compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
        bindings: [],
      },
      workerScript: {
        path: 'index.js',
        content: draftWorkerBuffer,
        mimeType: 'application/javascript+module',
      },
      dispatchNamespace,
    });
  }

  /**
   * Deploy a worker with its assets to Cloudflare
   */
  async deploy(params: {
    /** Worker script and asset files */
    artifacts: DeploymentArtifacts;
    /** Name of the worker */
    workerName: string;
    /** Callback for logging progress */
    logger: (message: string) => void;
    /** Dispatch namespace to deploy to */
    dispatchNamespace?: string;
    /** Optional environment variables (decrypted) */
    envVars?: PlaintextEnvVar[];
  }): Promise<void> {
    const { artifacts, workerName, logger, dispatchNamespace = 'kilo-deploy', envVars } = params;
    validateWorkerName(workerName);

    const workerScript = artifacts.workerScript;
    const artifactFiles = artifacts.artifacts;
    const assets = artifacts.assets;

    const secretEnvVars = envVars?.filter(v => v.isSecret) ?? [];
    const plainTextEnvVars = envVars?.filter(v => !v.isSecret) ?? [];

    // Set secrets
    if (secretEnvVars.length > 0) {
      try {
        await this.api.setSecrets(workerName, dispatchNamespace, secretEnvVars);
      } catch (error) {
        if (error instanceof WorkerNotFoundError) {
          logger('Worker does not exist, creating draft worker before setting secrets');
          await this.createDraftWorker(workerName, dispatchNamespace);

          await this.api.setSecrets(workerName, dispatchNamespace, secretEnvVars);
        } else {
          throw error;
        }
      }
    }

    // Handle case with no assets and no artifacts
    if (assets.length === 0 && artifactFiles.length === 0) {
      logger('No assets or artifacts found, deploying worker only');
      const metadata = {
        main_module: 'index.js',
        compatibility_date: '2025-09-01',
        compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
        bindings: [],
      };

      await this.api.deployWorker({
        scriptName: workerName,
        metadata,
        workerScript,
        dispatchNamespace,
        artifacts: artifactFiles,
        envVars: plainTextEnvVars,
      });

      logger(`Deployment complete: ${workerName} in namespace ${dispatchNamespace}`);
      return;
    }

    logger(`Found ${assets.length} asset files and ${artifactFiles.length} artifact files`);

    // Calculate hashes and build data structures
    const fileContents = new Map<string, { buffer: Buffer; mimeType: string }>();
    const manifest: Record<string, { hash: string; size: number }> = {};

    let totalBytes = 0;

    for (const asset of assets) {
      const fullHash = await calculateSHA256(asset.content);
      const hash = fullHash.substring(0, 32); // Cloudflare expects 32-char hash

      // Ensure path starts with forward slash for Cloudflare manifest
      const manifestPath = asset.path.startsWith('/') ? asset.path : `/${asset.path}`;

      const size = getByteSize(asset.content);

      fileContents.set(hash, {
        buffer: asset.content,
        mimeType: asset.mimeType,
      });
      manifest[manifestPath] = {
        hash,
        size,
      };
      totalBytes += size;
    }

    logger(`Built asset manifest with ${assets.length} files, ${totalBytes} total bytes`);

    // Create asset upload session
    const { jwt, buckets } = await this.api.createAssetUploadSession(
      workerName,
      manifest,
      dispatchNamespace
    );

    logger(`Created asset upload session, ${buckets.length} buckets to upload`);

    // Upload assets in batches
    let completionJwt: string | null = null;

    if (buckets.length === 0) {
      // All assets already exist (deduplication), use session JWT as completion JWT
      logger('All assets already exist on Cloudflare');
      completionJwt = jwt;
    } else {
      // Upload new/changed assets
      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        logger(`Uploading batch ${i + 1}/${buckets.length} (${bucket.length} files)`);

        const result = await this.api.uploadAssetBatch(workerName, jwt, bucket, fileContents);

        if (result) {
          completionJwt = result;
        }
      }

      if (!completionJwt) {
        throw new Error('Failed to get completion token from asset upload');
      }
    }

    logger('All assets uploaded successfully');

    // Build worker metadata with asset configuration
    const bindings: Array<Record<string, unknown>> = [
      {
        name: 'ASSETS',
        type: 'assets',
      },
    ];

    const metadata = {
      main_module: 'index.js',
      compatibility_date: '2025-09-01',
      compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
      bindings,
      assets: {
        jwt: completionJwt,
        config: {}, // Empty config - Cloudflare uses defaults
      },
    };

    // Deploy worker with artifact files
    await this.api.deployWorker({
      scriptName: workerName,
      metadata,
      workerScript,
      dispatchNamespace,
      artifacts: artifactFiles,
      envVars: plainTextEnvVars,
    });
  }
}
