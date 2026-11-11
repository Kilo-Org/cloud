import 'server-only';

import { cleanupSetupRuns } from '@kilocode/cloud-agent-profile';
import { db } from '@kilocode/web-shared/lib/drizzle';

export async function cleanupEnvironmentSetupRuns() {
  return cleanupSetupRuns(db, new Date());
}
