import 'server-only';

import { db } from '@/lib/drizzle';
import { createGatewayRepository } from './repository';
import { createOAuthGrantService } from './oauth-grant-service';

export async function revokeGatewayGrantsForBlockedUser(userId: string) {
  const oauthGrantService = createOAuthGrantService(createGatewayRepository(db));
  return await oauthGrantService.revokeAllForUser(userId, 'user_blocked');
}

export async function revokeGatewayGrantsForBlockedUsers(userIds: string[]) {
  const oauthGrantService = createOAuthGrantService(createGatewayRepository(db));
  return await oauthGrantService.revokeAllForUsers(userIds, 'user_blocked');
}
