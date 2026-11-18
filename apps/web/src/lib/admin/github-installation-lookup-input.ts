import * as z from 'zod';

const githubOrganizationLogin = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const githubOrganizationUrl = /^https:\/\/github\.com\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/?$/;

export const GitHubOrganizationInstallationLookupInputSchema = z
  .object({
    organization: z.string().max(256).trim().min(1),
  })
  .transform(({ organization }, ctx) => {
    const normalized = tryNormalizeGitHubOrganizationLogin(organization);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        path: ['organization'],
        message: 'Enter a valid GitHub organization login',
      });
      return z.NEVER;
    }
    return { organization: normalized };
  });

export type GitHubOrganizationInstallationLookupInput = z.infer<
  typeof GitHubOrganizationInstallationLookupInputSchema
>;

function tryNormalizeGitHubOrganizationLogin(value: string): string | null {
  let login = value.trim();
  const urlMatch = githubOrganizationUrl.exec(login);
  if (urlMatch?.[1]) login = urlMatch[1];
  else if (login.startsWith('@')) login = login.slice(1);

  if (login.length > 39 || !githubOrganizationLogin.test(login)) return null;
  return login.toLowerCase();
}

export function normalizeGitHubOrganizationLogin(value: string): string {
  const normalized = tryNormalizeGitHubOrganizationLogin(value);
  if (!normalized) throw new Error('Enter a valid GitHub organization login');
  return normalized;
}
