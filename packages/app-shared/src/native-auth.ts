import { z } from 'zod';

export const API_GATEWAY_CREDENTIAL_FORMAT = 'api-gateway-v1';

export const nativeCredentialFormatSchema = z.literal(API_GATEWAY_CREDENTIAL_FORMAT);

export type NativeCredentialFormat = z.infer<typeof nativeCredentialFormatSchema>;

const tokenSchema = z.string().min(1);
const expiresInSchema = z.number().positive();

export const nativeCredentialBundleMetadataSchema = z
  .object({
    credentialFormat: nativeCredentialFormatSchema,
    gatewayToken: tokenSchema,
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type NativeCredentialBundleMetadata = z.infer<typeof nativeCredentialBundleMetadataSchema>;

export type NativeAccessCredentials =
  | { token: string; metadata: NativeCredentialBundleMetadata }
  | { token: string; metadata?: undefined };

export type NativeSessionCredentials = NativeAccessCredentials & {
  refreshToken: string;
  expiresIn: number;
};

export type NativeTokenPair =
  | (NativeSessionCredentials & { created?: boolean })
  | {
      token: string;
      refreshToken?: undefined;
      expiresIn?: undefined;
      metadata?: undefined;
      created?: boolean;
    };

const completePairSchema = z.object({
  token: tokenSchema,
  refreshToken: tokenSchema,
  expiresIn: expiresInSchema,
  metadata: nativeCredentialBundleMetadataSchema,
  created: z.boolean().optional(),
});

const legacyPairSchema = z.object({
  token: tokenSchema,
  refreshToken: tokenSchema.optional(),
  expiresIn: expiresInSchema.optional(),
  created: z.boolean().optional(),
});

export function parseNativeTokenPair(value: unknown): NativeTokenPair | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'credentialFormat') || Object.hasOwn(record, 'gatewayToken'))
    return null;
  if (Object.hasOwn(record, 'metadata')) {
    const parsed = completePairSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  const parsed = legacyPairSchema.safeParse(value);
  if (!parsed.success) return null;

  const { token, refreshToken, expiresIn, created } = parsed.data;
  if (refreshToken && expiresIn) return { token, refreshToken, expiresIn, created };
  return { token, created };
}
