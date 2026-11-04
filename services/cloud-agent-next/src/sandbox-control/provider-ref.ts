import { z } from 'zod';

export const providerRefSchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    containment: z.boolean(),
    instanceId: z.string().min(1).max(128),
  })
  .strict();

export type CloudflareProviderRef = z.infer<typeof providerRefSchema>;

export function encodeCloudflareProviderRef(ref: CloudflareProviderRef): string {
  return JSON.stringify(ref);
}

export function decodeCloudflareProviderRef(raw: string | null): CloudflareProviderRef | null {
  if (raw === null) return null;
  try {
    const parsed = providerRefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
