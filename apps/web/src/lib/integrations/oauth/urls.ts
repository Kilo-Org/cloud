import 'server-only';

import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  getPlatformOAuthCallbackPath,
  type StandardOAuthPlatform,
} from '@/lib/integrations/oauth/paths';

export function getPlatformOAuthCallbackUrl(platform: StandardOAuthPlatform): string {
  return `${APP_URL}${getPlatformOAuthCallbackPath(platform)}`;
}
