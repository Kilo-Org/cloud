import { NextResponse } from 'next/server';
import { updateGitHubInstallationAccountIdentity } from '@/lib/integrations/db/github-installations';
import type { GitHubAppType } from '../app-selector';
import { fetchGitHubInstallationDetails } from '@/lib/integrations/platforms/github/adapter';
import type { InstallationTargetRenamedPayload } from '../webhook-schemas';
import { logExceptInTest } from '@/lib/utils.server';

export async function handleInstallationTargetRenamed(
  payload: InstallationTargetRenamedPayload,
  integration: { id: string; github_disconnected_at: string | null },
  appType: GitHubAppType
) {
  if (integration.github_disconnected_at) {
    return NextResponse.json({ message: 'Installation target ignored' }, { status: 200 });
  }
  const installationId = payload.installation.id.toString();
  const details = await fetchGitHubInstallationDetails(installationId, appType);

  if (!details.account.id || !details.account.login) {
    throw new Error('GitHub installation account identity missing after rename event');
  }

  await updateGitHubInstallationAccountIdentity({
    integrationId: integration.id,
    accountId: details.account.id.toString(),
    accountLogin: details.account.login,
  });

  logExceptInTest('GitHub App installation target renamed:', {
    installation_id: installationId,
    integration_id: integration.id,
    target_type: payload.target_type,
  });

  return NextResponse.json({ message: 'Installation target updated' }, { status: 200 });
}
