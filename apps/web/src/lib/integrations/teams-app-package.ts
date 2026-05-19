import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { APP_URL } from '@/lib/constants';
import { TEAMS_APP_ID } from '@/lib/config.server';

const TEAMS_APP_PACKAGE_FILE_NAME = 'kilo-teams-app.zip';

function getAppHost(): string {
  return new URL(APP_URL).hostname;
}

function getTeamsManifest() {
  const appHost = getAppHost();

  return {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: TEAMS_APP_ID,
    developer: {
      name: 'Kilo Code',
      websiteUrl: 'https://kilo.ai',
      privacyUrl: 'https://kilo.ai/privacy',
      termsOfUseUrl: 'https://kilo.ai/terms',
    },
    name: {
      short: 'Kilo',
      full: 'Kilo Code',
    },
    description: {
      short: 'Start Kilo coding work from Microsoft Teams.',
      full: 'Mention Kilo in Microsoft Teams chats, channels, and threads to start coding work from your workspace.',
    },
    icons: {
      color: 'color.png',
      outline: 'outline.png',
    },
    accentColor: '#EDFF00',
    bots: [
      {
        botId: TEAMS_APP_ID,
        scopes: ['personal', 'team', 'groupchat'],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    validDomains: [appHost],
  };
}

async function readPublicFile(relativePath: string): Promise<Uint8Array> {
  return await readFile(path.join(process.cwd(), 'public', relativePath));
}

export async function buildTeamsAppPackage(): Promise<Uint8Array> {
  if (!TEAMS_APP_ID) {
    throw new Error('TEAMS_APP_ID is required to build the Teams app package');
  }

  const manifest = JSON.stringify(getTeamsManifest(), null, 2);
  const icon = await readPublicFile('favicon/android-chrome-192x192.png');

  return zipSync({
    'manifest.json': strToU8(manifest),
    'color.png': icon,
    'outline.png': icon,
  });
}

export function getTeamsAppPackageFileName(): string {
  return TEAMS_APP_PACKAGE_FILE_NAME;
}
