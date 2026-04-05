import { sendAutoTopUpFailedEmail } from '@/lib/email';

async function main() {
  const email = process.argv[2];
  const reason = process.argv[3] || '';

  if (!email) {
    console.error('Usage: pnpm test:auto-topup-email <email> <reason>');
    console.error(
      'Example: pnpm test:auto-topup-email eamon@kilo.ai "Your card has insufficient funds."'
    );
    console.error('For empty reason: pnpm test:auto-topup-email eamon@kilo.ai ""');
    process.exit(1);
  }

  console.log(`Sending test auto-top-up failure email to ${email}`);
  console.log('Reason:', reason || '(empty)');

  await sendAutoTopUpFailedEmail(email, { reason });

  console.log('Email sent!');
}

main().catch(console.error);
