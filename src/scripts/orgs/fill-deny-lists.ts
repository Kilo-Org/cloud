import { db } from '@/lib/drizzle';
import { createDenyLists } from '@/lib/model-allow.server';
import { organizations } from '@kilocode/db';
import { desc, eq, or, sql } from 'drizzle-orm';

export async function run() {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      or(
        sql`${organizations.settings} ->> 'model_allow_list' is not null`,
        sql`${organizations.settings} ->> 'provider_allow_list' is not null`
      )
    )
    .orderBy(desc(organizations.created_at));
  console.log(`Updating ${rows.length} organizations`);
  for (const org of rows) {
    await db.transaction(async tran => {
      const [{ settings }] = await tran
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, org.id));

      if (settings.model_allow_list) {
        settings.model_allow_list = [...new Set(settings.model_allow_list)];
      }
      if (settings.provider_allow_list) {
        settings.provider_allow_list = [...new Set(settings.provider_allow_list)];
      }

      const denyLists = await createDenyLists(
        settings.model_allow_list,
        settings.provider_allow_list
      );

      settings.model_deny_list = denyLists?.model_deny_list;
      settings.provider_deny_list = denyLists?.provider_deny_list;

      await tran
        .update(organizations)
        .set({ settings })
        .where(eq(organizations.id, org.id))
        .execute();

      console.log(`Commit ${org.id}`);
    });
  }
}
