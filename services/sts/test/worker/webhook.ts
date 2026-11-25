import { z } from 'zod';

/** Builds a `secrets.modified` body the way Infisical sends it for the test project. */
export function webhookBody(options: {
  timestamp: number;
  environment?: string;
  event?: string;
}): string {
  return JSON.stringify({
    event: options.event ?? 'secrets.modified',
    project: {
      workspaceId: 'test-project-id',
      environment: options.environment ?? 'development',
      environmentName: 'Development',
      secretPath: '/workloads/o11y',
      changedBy: 'someone',
      changedByActorType: 'user',
    },
    timestamp: options.timestamp,
  });
}

/** Signs like Infisical: `t=<timestamp>;<hex HMAC-SHA256 of the body>` keyed by the secret string. */
export async function signWebhook(secret: string, body: string): Promise<string> {
  const document: unknown = JSON.parse(body);
  const { timestamp } = z.object({ timestamp: z.number() }).parse(document);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const hex = [...mac].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp};${hex}`;
}
