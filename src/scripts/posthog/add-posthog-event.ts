import '@/lib/load-env';
import { getEnvVariable } from '@/lib/dotenvx';
import { PostHog } from 'posthog-node';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const POSTHOG_INGESTION_HOST = 'https://us.i.posthog.com';

function parseEmails(csvPath: string): string[] {
  const absolutePath = resolve(csvPath);
  const content = readFileSync(absolutePath, 'utf-8');
  const lines = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) {
    throw new Error(`CSV file is empty: ${absolutePath}`);
  }

  const headerColumns = lines[0].split(',').map(col => col.trim().toLowerCase());
  const emailColIndex =
    headerColumns.indexOf('email') !== -1
      ? headerColumns.indexOf('email')
      : headerColumns.indexOf('emails');

  let emails: string[];

  if (emailColIndex !== -1) {
    // Multi-column CSV with an email header — extract that column
    emails = lines.slice(1).map(line => line.split(',')[emailColIndex]?.trim() ?? '');
  } else if (lines[0].includes(',')) {
    throw new Error(
      `CSV appears to have multiple columns but no "email" header.\n  Header: ${lines[0]}`
    );
  } else {
    // Single-column, no header (just emails)
    emails = lines;
  }

  emails = emails.filter(e => e.length > 0);

  const invalid = emails.filter(email => !email.includes('@'));
  if (invalid.length > 0) {
    throw new Error(
      `Found ${invalid.length} invalid email(s):\n  ${invalid.slice(0, 5).join('\n  ')}${invalid.length > 5 ? `\n  ... and ${invalid.length - 5} more` : ''}`
    );
  }

  return emails;
}

function usage(): never {
  console.error(
    'Usage: pnpm script src/scripts/posthog/add-posthog-event.ts <property-name> <csv-file> [--confirm]'
  );
  console.error('');
  console.error(
    '  <property-name>  Person property to set to true (e.g. kiloclaw-earliest-adopters)'
  );
  console.error('  <csv-file>       Path to a CSV file with one email per line');
  console.error('  --confirm        Actually send to PostHog (default is dry-run)');
  process.exit(1);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const positional = args.filter(a => a !== '--confirm');

  if (positional.length !== 2) {
    usage();
  }

  const [propertyName, csvPath] = positional;

  const emails = parseEmails(csvPath);

  console.log(`Property: ${propertyName} = true`);
  console.log(`Emails:   ${emails.length}`);
  console.log(`Mode:     ${confirm ? 'LIVE' : 'DRY-RUN'}`);
  console.log('');

  if (!confirm) {
    for (const email of emails) {
      console.log(`  [dry-run] would set "${propertyName}" on ${email}`);
    }
    console.log('');
    console.log(`Dry-run complete. ${emails.length} person(s) would be updated.`);
    console.log('Pass --confirm to send for real.');
    return;
  }

  const apiKey = getEnvVariable('NEXT_PUBLIC_POSTHOG_KEY');
  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_POSTHOG_KEY environment variable is required');
  }

  const posthog = new PostHog(apiKey, {
    host: POSTHOG_INGESTION_HOST,
    flushAt: 1,
    flushInterval: 0,
  });

  let sent = 0;
  for (const email of emails) {
    posthog.capture({
      distinctId: email,
      event: '$set',
      properties: {
        $set: { [propertyName]: true },
      },
    });
    sent++;
    if (sent % 100 === 0) {
      console.log(`  sent ${sent}/${emails.length}...`);
    }
  }

  console.log(`Flushing ${sent} update(s)...`);
  await posthog.shutdown();
  console.log(`Done. Set "${propertyName}" = true on ${sent} person(s).`);
}

run().then(
  () => process.exit(0),
  err => {
    console.error('Fatal error:', err);
    process.exit(1);
  }
);
