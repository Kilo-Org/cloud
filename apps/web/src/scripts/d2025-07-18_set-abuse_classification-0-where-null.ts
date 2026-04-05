import { microdollar_usage } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { count, isNull, sql } from 'drizzle-orm';

async function run() {
  while (true) {
    const [{ count: countRemaining }] = await db
      .select({ count: count() })
      .from(microdollar_usage)
      .where(isNull(microdollar_usage.abuse_classification));
    console.log('Remaining...', countRemaining);
    if (!countRemaining) break;
    await db.execute(sql`
      UPDATE microdollar_usage 
      SET abuse_classification = 0 
      WHERE id IN (
          SELECT id 
          FROM microdollar_usage 
          WHERE abuse_classification IS NULL 
          LIMIT 50000
      );
      `);
  }
  console.log('done.');
  process.exit();
}

void run();
