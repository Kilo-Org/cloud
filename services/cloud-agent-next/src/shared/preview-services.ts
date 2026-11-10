import { z } from 'zod';
import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from './preview-port';

/** Upper bound on one discovery answer; the scanner stops at this count. */
export const PREVIEW_SERVICES_MAX_COUNT = 50;

export const PREVIEW_SERVICE_NAME_MAX_LENGTH = 120;
export const PREVIEW_SERVICE_DESCRIPTION_MAX_LENGTH = 200;

/**
 * One listening service a preview could open. `name` is a safe display label
 * derived inside the sandbox; it never carries argv, environment values or
 * filesystem paths.
 */
export const PreviewServiceSchema = z
  .object({
    port: z.number().int().min(PREVIEW_PORT_MIN).max(PREVIEW_PORT_MAX),
    name: z.string().min(1).max(PREVIEW_SERVICE_NAME_MAX_LENGTH),
    description: z.string().min(1).max(PREVIEW_SERVICE_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type PreviewService = z.infer<typeof PreviewServiceSchema>;

export const PreviewServicesScanSchema = z
  .object({
    services: z.array(PreviewServiceSchema).max(PREVIEW_SERVICES_MAX_COUNT),
  })
  .strict();
export type PreviewServicesScan = z.infer<typeof PreviewServicesScanSchema>;

export const PREVIEW_SERVICES_STATUSES = [
  'running',
  'not_running',
  'not_ready',
  'unsupported',
] as const;

export const PreviewServicesStatusSchema = z.enum(PREVIEW_SERVICES_STATUSES);
export type PreviewServicesStatus = z.infer<typeof PreviewServicesStatusSchema>;

/**
 * Public Worker output. `running` with an empty list is a real result: the
 * sandbox is live and no listening service was found. `not_running`,
 * `not_ready` and `unsupported` always carry no services. Transport and scan
 * failures throw instead of masquerading as an empty answer.
 */
export const ListPreviewServicesOutputSchema = z
  .object({
    services: z.array(PreviewServiceSchema).max(PREVIEW_SERVICES_MAX_COUNT),
    status: PreviewServicesStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== 'running' && value.services.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['services'],
        message: 'a non-running status cannot carry discovered services',
      });
    }
  });
export type ListPreviewServicesOutput = z.infer<typeof ListPreviewServicesOutputSchema>;
