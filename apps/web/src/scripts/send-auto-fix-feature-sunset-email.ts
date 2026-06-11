import { sendAutoFixFeatureSunsetEmail } from '@/lib/email';

const recipients = [
  // Add the 17 identified auto-fix users here before running with --send.
] satisfies string[];

async function main() {
  const shouldSend = process.argv.includes('--send');

  if (recipients.length === 0) {
    console.error('No recipients configured. Add the auto-fix user emails to recipients first.');
    process.exit(1);
  }

  const uniqueRecipients = Array.from(new Set(recipients));
  if (uniqueRecipients.length !== recipients.length) {
    console.error('Duplicate recipients found. Remove duplicates before sending.');
    process.exit(1);
  }

  if (!shouldSend) {
    console.log('Dry run. Pass --send to send the auto-fix feature sunset email.');
    console.log(`Would send to ${uniqueRecipients.length} recipients:`);
    for (const recipient of uniqueRecipients) console.log(`- ${recipient}`);
    return;
  }

  console.log(`Sending auto-fix feature sunset email to ${uniqueRecipients.length} recipients.`);

  const failedRecipients: string[] = [];
  for (const recipient of uniqueRecipients) {
    const result = await sendAutoFixFeatureSunsetEmail(recipient);
    if (result.sent) {
      console.log(`Sent: ${recipient}`);
      continue;
    }

    failedRecipients.push(`${recipient} (${result.reason})`);
    console.error(`Failed: ${recipient} (${result.reason})`);
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
