import fs from 'fs';
import path from 'path';
import Mailgun from 'mailgun.js';
import FormData from 'form-data';

const templateVars = {
  disable_date: 'June 18, 2026',
  github_docs_url: 'https://kilo.ai/docs/code-with-ai/platforms/github',
  contact_email: 'hi@kilocode.ai',
  year: String(new Date().getFullYear()),
} satisfies Record<string, string>;

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderTemplate(name: string, vars: Record<string, string>): string {
  const templatePath = path.join(process.cwd(), 'src', 'emails', `${name}.html`);
  const html = fs.readFileSync(templatePath, 'utf-8');

  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Missing template variable '${key}'`);
    return escapeHtml(value);
  });
}

async function sendAutoFixFeatureSunsetEmail(to: string): Promise<void> {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN } = process.env;
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
    throw new Error('MAILGUN_API_KEY/MAILGUN_DOMAIN not configured');
  }

  const mailgun = new Mailgun(FormData);
  const client = mailgun.client({ username: 'api', key: MAILGUN_API_KEY });
  await client.messages.create(MAILGUN_DOMAIN, {
    from: 'Kilo Code <hi@app.kilocode.ai>',
    'h:Reply-To': 'hi@kilocode.ai',
    to,
    subject: 'Kilo: Auto-Fix Feature Sunset',
    html: renderTemplate('autoFixFeatureSunset', templateVars),
  });
}

function getTestRecipient(): string | undefined {
  const testFlagIndex = process.argv.indexOf('--test');
  if (testFlagIndex === -1) return undefined;

  const recipient = process.argv[testFlagIndex + 1];
  if (!recipient || recipient.startsWith('--')) {
    console.error(
      'Usage: pnpm exec tsx src/scripts/send-auto-fix-feature-sunset-email.ts --test <email>'
    );
    process.exit(1);
  }

  return recipient;
}

const recipients = [
  'remon@kilocode.ai',
  'kimptoc@gmail.com',
  'dutch2005@gmail.com',
  'gemejl1337@gmail.com',
  'pmaclyman@gmail.com',
  'mutdashboard@gmail.com',
  'petr.plenkov@gmail.com',
  'arthursrodrigues@gmail.com',
  'beowulf4756@gmail.com',
  'vivetbilab@gmail.com',
  'tomkristian.abel@tomabel.ee',
  'thomas.brugman.teb3@gmail.com',
  'sylvain.gavel@gmail.com',
  'kilo@talk2machines.com',
  'thompson.trent@gmail.com',
  'billlzzz19@gmail.com',
  'romanfinal@proton.me',
  'github@mail.vkvikram.com',
  // Add the 17 identified auto-fix users here before running with --send.
] satisfies string[];

async function main() {
  const shouldSend = process.argv.includes('--send');
  const testRecipient = getTestRecipient();
  const targetRecipients = testRecipient ? [testRecipient] : recipients;

  if (targetRecipients.length === 0) {
    console.error('No recipients configured. Add the auto-fix user emails to recipients first.');
    process.exit(1);
  }

  const uniqueRecipients = Array.from(new Set(targetRecipients));
  if (uniqueRecipients.length !== targetRecipients.length) {
    console.error('Duplicate recipients found. Remove duplicates before sending.');
    process.exit(1);
  }

  if (!shouldSend && !testRecipient) {
    console.log('Dry run. Pass --send to send the auto-fix feature sunset email.');
    console.log('Pass --test <email> to send a single test email.');
    console.log(`Would send to ${uniqueRecipients.length} recipients:`);
    for (const recipient of uniqueRecipients) console.log(`- ${recipient}`);
    return;
  }

  console.log(
    testRecipient
      ? `Sending test auto-fix feature sunset email to ${testRecipient}.`
      : `Sending auto-fix feature sunset email to ${uniqueRecipients.length} recipients.`
  );

  const failedRecipients: string[] = [];
  for (const recipient of uniqueRecipients) {
    try {
      await sendAutoFixFeatureSunsetEmail(recipient);
      console.log(`Sent: ${recipient}`);
    } catch (error) {
      failedRecipients.push(recipient);
      console.error(`Failed: ${recipient}`);
      console.error(error);
    }
  }

  if (failedRecipients.length > 0) {
    console.error('Some recipients failed:');
    for (const recipient of failedRecipients) console.error(`- ${recipient}`);
    process.exit(1);
  }

  console.log('All emails sent.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
