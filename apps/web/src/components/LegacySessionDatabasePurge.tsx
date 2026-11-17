'use client';

import { useEffect } from 'react';
import { purgeLegacySessionDatabase } from '@/lib/cloud-agent/legacy-session-database';

/**
 * Mounted by the authenticated app shell. Renders nothing; it only makes a
 * browser that still holds the legacy cloud agent session database drop it.
 */
export function LegacySessionDatabasePurge() {
  useEffect(() => {
    purgeLegacySessionDatabase();
  }, []);

  return null;
}
