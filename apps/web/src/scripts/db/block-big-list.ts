import { kilocode_users } from '@kilocode/db/schema';
import { pool, db } from '@/lib/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import fs from 'node:fs';

export async function run() {
  //data was at https://drive.google.com/open?id=1_z8zHZ-AEustzqki4eZjP9A-tvqYvnN9

  // get dirname of this file
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const dirname = new URL('.', import.meta.url).pathname;

  console.log('string', pool.options);

  const outputFile = fs.createWriteStream(`${dirname}/block-log.txt`);

  const list = fs
    .readFileSync(`${dirname}/block-list.txt`, 'utf-8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  for (const email of list) {
    console.log('blocking', email);
    outputFile.write(`blocking: ${email}\n`);
    const result = await db
      .update(kilocode_users)
      .set({
        blocked_reason: 'stytch-attacker-list',
        blocked_at: new Date().toISOString(),
        blocked_by_kilo_user_id: null,
      })
      .where(
        and(eq(kilocode_users.google_user_email, email), isNull(kilocode_users.blocked_reason))
      )
      .returning();
    if (result && result.length) {
      const user = result[0];
      const txt = `blocked: ${user.google_user_email} - ${user.has_validation_novel_card_with_hold} - ${user.microdollars_used}`;
      outputFile.write(`${txt}\n`);
      console.log(txt);
    } else {
      console.log('no user');
    }
  }

  console.log(list);
}
