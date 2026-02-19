import jwt from 'jsonwebtoken';
import { APP_BUILDER_TICKET_SECRET, APP_BUILDER_URL } from '@/lib/config.server';

export function signEventTicket(
  projectId: string,
  userId: string
): { ticket: string; expiresAt: number; workerUrl: string } {
  if (!APP_BUILDER_TICKET_SECRET) {
    throw new Error('APP_BUILDER_TICKET_SECRET is not configured');
  }
  if (!APP_BUILDER_URL) {
    throw new Error('APP_BUILDER_URL is not configured');
  }

  const expiresInSeconds = 300; // 5 minutes
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

  const ticket = jwt.sign(
    {
      type: 'app_builder_event',
      userId,
      projectId,
    },
    APP_BUILDER_TICKET_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
    }
  );

  return { ticket, expiresAt, workerUrl: APP_BUILDER_URL };
}
