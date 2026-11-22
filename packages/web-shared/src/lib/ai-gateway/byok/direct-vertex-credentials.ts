import * as z from 'zod';
import { GoogleServiceAccountSigningKeySchema } from '@kilocode/db/schema-types';
import { VertexCredentialsSchema } from '@kilocode/app-shared/byok-credentials';

// The BYOK credential shapes for Google Vertex, including the service-account
// key-file form; they live here so the provider-id module stays a provider-id
// registry.

/**
 * A Google Cloud service account key file, as downloaded from the console, with
 * an optional Vertex AI `location`. Only the fields needed to sign token
 * requests and address the project are required.
 */
export const GoogleServiceAccountKeyFileSchema = GoogleServiceAccountSigningKeySchema.extend({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  location: z.string().trim().min(1).optional(),
});

/**
 * Direct Vertex AI BYOK accepts the Vercel-shaped `VertexCredentialsSchema`, or
 * a service account key file with an optional `location` (default `global`).
 */
export const DirectVertexCredentialsSchema = z.union([
  VertexCredentialsSchema,
  GoogleServiceAccountKeyFileSchema,
]);

export type DirectVertexCredentials = z.infer<typeof DirectVertexCredentialsSchema>;
