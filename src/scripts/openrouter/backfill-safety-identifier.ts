import { db } from '@/lib/drizzle';
import { generateOpenRouterUpstreamSafetyIdentifier } from '@/lib/providerHash';
import { kilocode_users } from '@kilocode/db';
import { isNull, desc, eq } from 'drizzle-orm';

export async function run() {
  while (true) {
    const count = await db.transaction(async tran => {
      const rows = await tran
        .select({
          id: kilocode_users.id,
        })
        .from(kilocode_users)
        .where(isNull(kilocode_users.openrouter_upstream_safety_identifier))
        .orderBy(desc(kilocode_users.created_at))
        .limit(1000);
      if (rows.length === 0) {
        return 0;
      }
      console.log(`Batch of ${rows.length} users`);
      for (const user of rows) {
        const openrouter_upstream_safety_identifier = generateOpenRouterUpstreamSafetyIdentifier(
          user.id
        );
        await tran
          .update(kilocode_users)
          .set({
            openrouter_upstream_safety_identifier,
          })
          .where(eq(kilocode_users.id, user.id))
          .execute();
      }
      console.log('Commit');
      return rows.length;
    });
    if (count === 0) {
      break;
    }
  }
}
