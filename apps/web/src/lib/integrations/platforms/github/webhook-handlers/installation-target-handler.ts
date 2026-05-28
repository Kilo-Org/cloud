import { NextResponse } from 'next/server';
import { updateIntegrationAccountIdentity } from '@/lib/integrations/db/platform-integrations';
import type { GitHubAppType } from '../app-selector';
import { fetchGitHubInstallationDetails } from '@/lib/integrations/platforms/github/adapter';
import type { InstallationTargetRenamedPayload } from '../webhook-schemas';
import { logExceptInTest } from '@/lib/utils.server';

export async function handleInstallationTargetRenamed(
  payload: InstallationTargetRenamedPayload,
  integrationId: string,
  appType: GitHubAppType
) {
  const installationId = payload.installation.id.toString();
  const details = await fetchGitHubInstallationDetails(installationId, appType);

  if (!details.account.id || !details.account.login) {
    throw new Error('GitHub installation account identity missing after rename event');
  }

  await updateIntegrationAccountIdentity(
    integrationId,
    details.account.id.toString(),
    details.account.login
  );

  logExceptInTest('GitHub App installation target renamed:', {
    installation_id: installationId,
    integration_id: integrationId,
    target_type: payload.target_type,
  });

  return NextResponse.json({ message: 'Installation target updated' }, { status: 200 });
}
