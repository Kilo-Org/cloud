import { z } from 'zod';
import type { BaseEvidence } from './runtime-ci-release.js';

export function cloudflareAPI(accountId: string, token: string, request = fetch) {
  return async (resource: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/${resource}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        }
      );
    } catch {
      throw new Error(`Cloudflare release API ${resource} request failed`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cloudflare release API ${resource} failed (${response.status})`);
    }
    return response.json();
  };
}

export async function registryDigest(
  accountId: string,
  reference: string,
  api: ReturnType<typeof cloudflareAPI>,
  request = fetch
) {
  if (!reference.startsWith(`registry.cloudflare.com/${accountId}/`))
    throw new Error('base image is outside the managed account registry');
  const credentials = z
    .object({
      success: z.literal(true),
      result: z.object({ username: z.string().min(1), password: z.string().min(1) }),
    })
    .parse(
      await api('containers/registries/registry.cloudflare.com/credentials', {
        expiration_minutes: 5,
        permissions: ['pull'],
      })
    ).result;
  const repository = reference.slice('registry.cloudflare.com/'.length);
  const separator = repository.includes('@')
    ? repository.lastIndexOf('@')
    : repository.lastIndexOf(':');
  if (separator === -1) throw new Error('base image must have an explicit reference');
  let response: Response;
  try {
    response = await request(
      `https://registry.cloudflare.com/v2/${repository.slice(0, separator)}/manifests/${repository.slice(separator + 1)}`,
      {
        method: 'HEAD',
        headers: {
          Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
          Accept:
            'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
        },
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch {
    throw new Error('managed registry verification request failed');
  }
  if (!response.ok) throw new Error(`managed registry verification failed (${response.status})`);
  return z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(response.headers.get('Docker-Content-Digest'));
}

export async function verifyManagedBase(
  base: BaseEvidence,
  accountId: string,
  api: ReturnType<typeof cloudflareAPI>,
  request = fetch
) {
  if ((await registryDigest(accountId, base.image, api, request)) !== base.image.split('@')[1])
    throw new Error('managed registry digest differs from base evidence');
}

export async function assertDeployedSourceOrder(options: {
  workerName: string;
  sourceSha: string;
  api: ReturnType<typeof cloudflareAPI>;
  isAncestor: (older: string, newer: string) => Promise<boolean>;
}) {
  const deployments = z
    .object({
      success: z.literal(true),
      result: z.object({
        deployments: z.array(
          z.object({
            versions: z.array(z.object({ version_id: z.string().uuid(), percentage: z.number() })),
          })
        ),
      }),
    })
    .parse(
      await options.api(`workers/scripts/${encodeURIComponent(options.workerName)}/deployments`)
    );
  const latest = deployments.result.deployments[0];
  for (const version of latest?.versions ?? []) {
    if (version.percentage <= 0) continue;
    const details = z
      .object({
        success: z.literal(true),
        result: z.object({ annotations: z.record(z.string(), z.string()).optional() }),
      })
      .parse(
        await options.api(
          `workers/scripts/${encodeURIComponent(options.workerName)}/versions/${version.version_id}`
        )
      );
    const tag = details.result.annotations?.['workers/tag'];
    if (!tag?.startsWith('runtime-ci-')) continue;
    const deployedSha = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(tag.slice('runtime-ci-'.length));
    if (!(await options.isAncestor(deployedSha, options.sourceSha)))
      throw new Error(
        'ordinary Cloud Agent deployment is stale or divergent; intentional rollback requires separate approval'
      );
  }
}
