import { createTeamsAdapter, type TeamsAdapterConfig } from '@chat-adapter/teams';
import {
  TEAMS_APP_ID,
  TEAMS_APP_PASSWORD,
  TEAMS_APP_TENANT_ID,
  TEAMS_APP_TYPE,
} from '@/lib/config.server';

const teamsAppType: TeamsAdapterConfig['appType'] =
  TEAMS_APP_TYPE === 'SingleTenant' ? 'SingleTenant' : 'MultiTenant';

function isTeamsConfigured(): boolean {
  if (!TEAMS_APP_ID || !TEAMS_APP_PASSWORD) return false;
  if (teamsAppType === 'SingleTenant' && !TEAMS_APP_TENANT_ID) return false;
  return true;
}

export const teamsAdapter = isTeamsConfigured()
  ? createTeamsAdapter({
      appId: TEAMS_APP_ID,
      appPassword: TEAMS_APP_PASSWORD,
      appTenantId: TEAMS_APP_TENANT_ID,
      appType: teamsAppType,
      userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk',
    })
  : null;
