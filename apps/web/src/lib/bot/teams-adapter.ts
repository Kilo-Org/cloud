import { createTeamsAdapter } from '@chat-adapter/teams';
import { TEAMS_APP_ID, TEAMS_APP_PASSWORD } from '@/lib/config.server';

function isTeamsConfigured(): boolean {
  if (!TEAMS_APP_ID || !TEAMS_APP_PASSWORD) return false;
  return true;
}

export const teamsAdapter = isTeamsConfigured()
  ? createTeamsAdapter({
      appId: TEAMS_APP_ID,
      appPassword: TEAMS_APP_PASSWORD,
      appType: 'MultiTenant',
      userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk',
    })
  : null;
