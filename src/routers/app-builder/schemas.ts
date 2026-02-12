import * as z from 'zod';
import {
  APP_BUILDER_IMAGE_MAX_SIZE_BYTES,
  APP_BUILDER_IMAGE_ALLOWED_TYPES,
  APP_BUILDER_GALLERY_TEMPLATES,
} from '@/lib/app-builder/constants';
import { imagesSchema } from '@/lib/images-schema';

// Base schemas for app builder operations (without organizationId)
export const createProjectBaseSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),
  title: z.string().optional(),
  images: imagesSchema,
  template: z.enum(APP_BUILDER_GALLERY_TEMPLATES).optional(),
  /** Mode for the cloud agent session. Use 'ask' for templates, omit for default behavior */
  mode: z.enum(['code', 'ask']).optional(),
});

export const projectIdBaseSchema = z.object({
  projectId: z.uuid(),
});

export const sendMessageBaseSchema = z.object({
  projectId: z.uuid(),
  message: z.string().min(1),
  images: imagesSchema,
  /** Optional model override - if provided, updates the project's model_id */
  model: z.string().min(1).optional(),
});

// Common extension for organizationId
export const organizationIdSchema = z.object({
  organizationId: z.uuid(),
});

// Image upload URL request schema
export const getImageUploadUrlSchema = z.object({
  messageUuid: z.uuid(),
  imageId: z.uuid(),
  contentType: z.enum(APP_BUILDER_IMAGE_ALLOWED_TYPES),
  contentLength: z.number().int().positive().max(APP_BUILDER_IMAGE_MAX_SIZE_BYTES),
});

// Schema for prepareLegacySession
export const prepareLegacySessionBaseSchema = z.object({
  projectId: z.uuid(),
  model: z.string().min(1),
  prompt: z.string().min(1),
});

// Schema for migrateToGitHub
// User-created repository approach: users provide full repo name (owner/repo)
export const migrateToGitHubSchema = z.object({
  projectId: z.uuid(),
  repoFullName: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'Must be in format owner/repo'),
});
