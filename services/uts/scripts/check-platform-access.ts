import pg from 'pg';
import { z } from 'zod';
import { operatorClientConfig } from './connection';
import { checkPlatformAccess } from './platform-access';

/**
 * Deploy-time check of roles outside the UTS role matrix (README, "Platform roles"). Prints the
 * members of the predefined data roles and every privilege a Supabase API role holds on the
 * identity store, and exits with status 1 when there is any such privilege.
 * `UTS_MIGRATION_DATABASE_URL` is the same admin connection the migrator uses.
 */

const environment = z
  .object({ UTS_MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) })
  .parse(process.env);

const client = new pg.Client(operatorClientConfig(environment.UTS_MIGRATION_DATABASE_URL));
await client.connect();
try {
  const report = await checkPlatformAccess(client);
  for (const { role, member } of report.dataRoleMembers) console.log(`${role} member: ${member}`);
  console.log(`platform roles present: ${report.presentRoles.join(', ') || 'none'}`);
  for (const { role, privilege } of report.findings) console.log(`FAIL ${role}: ${privilege}`);
  if (report.findings.length > 0) process.exitCode = 1;
  else console.log('no platform role holds a privilege on the identity store');
} finally {
  await client.end();
}
