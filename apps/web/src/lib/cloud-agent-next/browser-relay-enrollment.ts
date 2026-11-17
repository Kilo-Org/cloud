import 'server-only';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import {
  APP_CLIENT_HEADER,
  isMobileClient,
  type AppHeaderList,
} from '@kilocode/web-shared/lib/app-headers';
import type { CloudAgentNextClient, PrepareSessionInput } from './cloud-agent-client';

export const CLOUD_AGENT_RELAY_CHAT_FLAG = 'cloud-agent-relay-chat';

export async function browserPrepareChat({
  userId,
  headers,
  client,
  repository,
  organizationId,
}: {
  userId: string;
  headers?: AppHeaderList | null;
  client: Pick<CloudAgentNextClient, 'getSandboxSelectionOptions'>;
  repository: Pick<PrepareSessionInput, 'githubRepo' | 'gitUrl' | 'platform'>;
  organizationId?: string;
}): Promise<PrepareSessionInput['chat']> {
  const caller = headers?.get(APP_CLIENT_HEADER);
  if (isMobileClient(caller) || (caller != null && caller !== 'web')) return undefined;
  if (!(await isReleaseToggleEnabled(CLOUD_AGENT_RELAY_CHAT_FLAG, userId))) return undefined;
  const capabilities = await client.getSandboxSelectionOptions({
    ...(organizationId ? { kilocodeOrganizationId: organizationId } : {}),
    ...(repository.githubRepo
      ? { repositoryType: 'github', repositoryFullName: repository.githubRepo }
      : { repositoryType: repository.platform ?? 'git' }),
  });
  return capabilities.relayChatForBrowserPrepare === true ? { transport: 'relay' } : undefined;
}
