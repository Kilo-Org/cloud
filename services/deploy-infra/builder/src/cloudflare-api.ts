import * as z from 'zod';
import type { DeploymentFile, WorkerMetadata } from './types';
import type { PlaintextEnvVar } from '../../../../apps/web/src/lib/user-deployments/env-vars-validation';

/**
 * Cloudflare API Client - Handles interactions with Cloudflare Workers API.
 * Provides methods for asset uploads and worker deployments.
 */

/**
 * Error thrown when a worker is not found in Cloudflare (error code 10007).
 */
export class WorkerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerNotFoundError';
  }
}

/**
 * Standard Cloudflare API response structure.
 */
const cloudflareErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
});

const baseResponseSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  errors: z.array(cloudflareErrorSchema).nullable().optional(),
});

type CloudflareApiError = z.infer<typeof cloudflareErrorSchema>;

export type CloudflareApiResponse<T> = {
  success: boolean;
  result?: T;
  errors?: CloudflareApiError[];
};

export const parseCloudflareResponse = <T>(
  raw: unknown,
  resultSchema: z.ZodType<T>
): CloudflareApiResponse<T> => {
  const parsed = baseResponseSchema.parse(raw);
  const parsedResult = parsed.result === undefined ? undefined : resultSchema.parse(parsed.result);

  return {
    success: parsed.success,
    errors: parsed.errors ?? undefined,
    result: parsedResult,
  };
};

/**
 * CloudflareAPI class for interacting with Cloudflare Workers API.
 * Handles asset upload sessions, batch uploads, and worker deployments.
 */
export class CloudflareAPI {
  private accountId: string;
  private apiToken: string;

  /**
   * Create a new CloudflareAPI instance.
   *
   * @param accountId - Cloudflare account ID
   * @param apiToken - Cloudflare API token with Workers deployment permissions
   */
  constructor(accountId: string, apiToken: string) {
    this.accountId = accountId;
    this.apiToken = apiToken;
  }

  /**
   * Get headers for API requests.
   *
   * @param contentType - Optional Content-Type header value
   * @returns Headers object with authorization and optional content type
   */
  private getHeaders(contentType?: string): HeadersInit {
    const headers: HeadersInit = {
      Authorization: `Bearer ${this.apiToken}`,
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return headers;
  }

  /**
   * Retry a function with exponential backoff for transient errors
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operation: string,
    maxAttempts: number = 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a 5xx error (transient)
        const is5xxError = lastError.message.includes('status: 5');

        if (!is5xxError || attempt === maxAttempts) {
          throw lastError;
        }

        // Exponential backoff: 1s, 2s, 4s, etc., max 30s
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(
          `${operation} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // lastError will always be set if we reach here due to loop logic
    throw lastError ?? new Error('Unknown error in retry logic');
  }

  /**
   * Create an asset upload session for a worker script.
   *
   * @param scriptName - Name of the worker script
   * @param manifest - Manifest mapping file paths to their hash and size
   * @param dispatchNamespace - Dispatch namespace for the worker
   * @returns Upload session JWT and bucket assignments
   */
  async createAssetUploadSession(
    scriptName: string,
    manifest: Record<string, { hash: string; size: number }>,
    dispatchNamespace: string
  ): Promise<{ jwt: string; buckets: string[][] }> {
    return await this.retryWithBackoff(async () => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/assets-upload-session`;

      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders('application/json'),
        body: JSON.stringify({ manifest }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errorObj: unknown = JSON.parse(errorText);

        throw new Error('Failed to create asset upload session', {
          cause: errorObj,
        });
      }

      const rawResponse: unknown = await response.json();
      const data = parseCloudflareResponse(
        rawResponse,
        z.object({
          jwt: z.string(),
          buckets: z.array(z.array(z.string())),
        })
      );

      if (!data.success || !data.result) {
        throw new Error('Asset upload session creation failed', {
          cause: data.errors,
        });
      }

      return data.result as { jwt: string; buckets: string[][] };
    }, 'Create asset upload session');
  }

  /**
   * Upload a batch of assets to Cloudflare.
   *
   * @param uploadToken - JWT token from the upload session
   * @param fileHashes - Array of file hashes to upload in this batch
   * @param fileContents - Map of hash to file content (Buffer) and MIME type
   * @returns Completion JWT if all files uploaded (status 201), null otherwise
   */
  async uploadAssetBatch(
    scriptName: string,
    uploadToken: string,
    fileHashes: string[],
    fileContents: Map<string, { buffer: Buffer; mimeType: string }>
  ): Promise<string | null> {
    return await this.retryWithBackoff(async () => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/assets/upload?base64=true`;

      // Build FormData with each file
      const formData = new FormData();

      for (const hash of fileHashes) {
        const fileData = fileContents.get(hash);
        if (!fileData) {
          throw new Error(`Missing file content for hash ${hash}`);
        }

        // Convert Buffer to base64 string (matches VibeSDK pattern)
        const base64Content = fileData.buffer.toString('base64');

        // Create blob with base64 content as text
        const blob = new Blob([base64Content], { type: fileData.mimeType });

        // Append to form data with hash as both field name and filename
        formData.append(hash, blob, hash);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${uploadToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorObj: unknown;
        try {
          errorObj = JSON.parse(errorText);
        } catch (parseError) {
          throw new Error('Failed to upload asset batch', {
            cause: { errorText, parseError },
          });
        }

        throw new Error('Failed to upload asset batch', {
          cause: errorObj,
        });
      }

      // Status 201 means all assets uploaded, returns completion JWT
      if (response.status === 201) {
        const rawResponse: unknown = await response.json();
        const data = parseCloudflareResponse(
          rawResponse,
          z.object({
            jwt: z.string(),
          })
        );

        if (!data.success) {
          throw new Error('Asset batch upload completion response indicated failure', {
            cause: data,
          });
        }

        if (!data.result?.jwt) {
          throw new Error('Asset batch upload missing completion token', {
            cause: data,
          });
        }

        return data.result?.jwt;
      }

      // Status 200 means partial upload, more batches needed
      return null;
    }, 'Upload asset batch');
  }

  /**
   * Deploy a worker script to Cloudflare.
   */
  async deployWorker(params: {
    /** Name of the worker script */
    scriptName: string;
    /** Worker metadata including main module, compatibility settings, and assets */
    metadata: WorkerMetadata;
    /** Worker script file */
    workerScript: DeploymentFile;
    /** Dispatch namespace for the worker */
    dispatchNamespace: string;
    /** Optional array of artifact files to include in deployment */
    artifacts?: DeploymentFile[];
    /** Environment variables (only non-secret) */
    envVars?: PlaintextEnvVar[];
  }): Promise<void> {
    const { scriptName, metadata, workerScript, dispatchNamespace, artifacts, envVars } = params;

    // Assert that envVars don't contain any secret variables
    if (envVars?.some(v => v.isSecret)) {
      throw new Error(
        'Secret environment variables must be set via setSecrets(), not deployWorker()'
      );
    }

    return await this.retryWithBackoff(async () => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}`;

      // Add plain text environment variables to metadata bindings
      const plainTextBindings = (envVars || []).map(v => ({
        type: 'plain_text',
        name: v.key,
        text: v.value,
      }));

      const metadataWithEnvVars = {
        ...metadata,
        bindings: [...(metadata.bindings ?? []), ...plainTextBindings],
      };

      const formData = new FormData();
      formData.append('metadata', JSON.stringify(metadataWithEnvVars));

      const workerBlob = new Blob([new Uint8Array(workerScript.content)], {
        type: 'application/javascript+module',
      });
      formData.append('index.js', workerBlob, 'index.js');

      // Append artifact files if provided
      if (artifacts && artifacts.length > 0) {
        for (const artifact of artifacts) {
          const artifactBlob = new Blob([new Uint8Array(artifact.content)], {
            type: artifact.mimeType,
          });
          formData.append(artifact.path, artifactBlob, artifact.path);
        }
      }

      const response = await fetch(url, {
        method: 'PUT',
        headers: this.getHeaders(),
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorObj: unknown;

        try {
          errorObj = JSON.parse(errorText);
        } catch (parseError) {
          throw new Error('Failed to deploy worker', {
            cause: { errorText, parseError },
          });
        }

        // Handle Durable Object class already exists (error code 10074)
        const errors =
          typeof errorObj === 'object' &&
          errorObj !== null &&
          'errors' in errorObj &&
          Array.isArray(errorObj.errors)
            ? (errorObj.errors as Array<Record<string, unknown>>)
            : [];
        const firstError = errors[0];
        if (firstError?.code === 10074) {
          const messageStr = typeof firstError.message === 'string' ? firstError.message : '';
          const existingClass = messageStr.match(/class "([^"]+)"/)?.[1];

          if (existingClass && metadata.migrations) {
            // Filter out the existing class from migrations
            const filteredMigrations = metadata.migrations
              .map(migration => ({
                ...migration,
                new_classes: migration.new_classes?.filter(cls => cls !== existingClass),
              }))
              .filter(migration => !migration.new_classes || migration.new_classes.length > 0);

            // Retry with filtered migrations (preserve envVars for retry)
            return await this.deployWorker({
              scriptName,
              metadata: { ...metadata, migrations: filteredMigrations },
              workerScript,
              dispatchNamespace,
              artifacts,
              envVars,
            });
          }

          throw new Error(`Durable Object class already exists: ${messageStr}`);
        }

        throw new Error('Failed to deploy worker', {
          cause: errorObj,
        });
      }
    }, 'Deploy worker');
  }

  /**
   * Sets secrets for a worker in a dispatch namespace using Cloudflare's Secrets API.
   * Secrets are set individually via PUT requests, processed in parallel batches.
   */
  async setSecrets(
    scriptName: string,
    dispatchNamespace: string,
    secrets: PlaintextEnvVar[]
  ): Promise<void> {
    const batchSize = 5;

    for (let i = 0; i < secrets.length; i += batchSize) {
      const batch = secrets.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async ({ key, value }) => {
          const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/secrets`;

          const response = await this.retryWithBackoff(async () => {
            return fetch(url, {
              method: 'PUT',
              headers: {
                ...this.getHeaders(),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ name: key, text: value, type: 'secret_text' }),
            });
          }, `Set secret ${key}`);

          if (!response.ok) {
            const cResponse = parseCloudflareResponse(await response.json(), z.unknown());

            // Check if worker doesn't exist (error code 10007 is "workers.api.error.script_not_found")
            if (cResponse.errors && cResponse.errors.length > 0) {
              const notFoundError = cResponse.errors.find(err => err.code === 10007);

              if (notFoundError) {
                throw new WorkerNotFoundError(`Worker not found: ${notFoundError.message}`);
              }
            }

            throw new Error(`Failed to set secret ${key}`, {
              cause: cResponse,
            });
          }
        })
      );
    }
  }

  /**
   * Delete a worker script from a dispatch namespace.
   * Note: Assets are automatically cleaned up when the script is deleted.
   *
   * @param scriptName - Name of the worker script to delete
   * @param dispatchNamespace - Dispatch namespace containing the worker
   */
  async deleteWorker(scriptName: string, dispatchNamespace: string): Promise<void> {
    return await this.retryWithBackoff(async () => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });

      const rawResponse: unknown = await response.json();
      const data = parseCloudflareResponse(rawResponse, z.unknown());

      if (data.success) {
        return;
      }

      // Check if worker doesn't exist (error code 10007 is "workers.api.error.script_not_found")
      if (data.errors && data.errors.length > 0) {
        const notFoundError = data.errors.find(
          err => err.code === 10007 || err.message.toLowerCase().includes('not found')
        );

        if (notFoundError) {
          // Worker doesn't exist, treat as success
          return;
        }
      }

      throw new Error('Failed to delete worker', {
        cause: data.errors,
      });
    }, 'Delete worker');
  }
}
