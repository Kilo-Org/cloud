import * as z from 'zod';

const positiveSafeDecimal = z
  .string()
  .max(16)
  .regex(/^[1-9]\d*$/)
  .refine(value => Number.isSafeInteger(Number(value)));

export const GitHubInstallationUninstallInputSchema = z
  .object({
    integrationId: z.uuid(),
    installationId: positiveSafeDecimal,
    accountId: positiveSafeDecimal,
    appType: z.enum(['standard', 'lite']),
    owner: z
      .object({
        type: z.enum(['user', 'organization']),
        id: z.string().min(1).max(1024),
      })
      .superRefine((owner, ctx) => {
        if (owner.type === 'organization' && !z.uuid().safeParse(owner.id).success) {
          ctx.addIssue({ code: 'custom', path: ['id'], message: 'Organization ID must be a UUID' });
        }
      }),
    confirmation: z.string(),
  })
  .refine(input => input.confirmation === input.installationId, {
    path: ['confirmation'],
    message: 'Confirmation must match the installation ID',
  });

export type GitHubInstallationUninstallInput = z.infer<
  typeof GitHubInstallationUninstallInputSchema
>;
