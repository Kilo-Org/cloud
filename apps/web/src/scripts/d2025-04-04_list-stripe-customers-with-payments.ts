import { getEnvVariable } from '@/lib/dotenvx';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';

// Initialize Stripe client
const client = new Stripe(getEnvVariable('STRIPE_SECRET_KEY'));

interface CustomerResults {
  total: number;
  customersWithPayments: {
    customerId: string;
    kiloUserId: string;
    email: string | null;
    paymentMethodCount: number;
    successfulPaymentsCount: number;
  }[];
}

async function listCustomersWithPayments() {
  console.log('Starting customer payment history scan...');
  let processedCustomers = 0;

  const results: CustomerResults = {
    total: 0,
    customersWithPayments: [],
  };

  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const customers = await client.customers.list({
      limit: 100,
      starting_after: startingAfter,
      expand: ['data.subscriptions'],
    });

    for (const customer of customers.data) {
      processedCustomers++;

      if (customer.metadata?.kiloUserId) {
        // Check for successful payments
        const payments = await client.paymentIntents.list({
          customer: customer.id,
          limit: 100,
        });

        const successfulPayments = payments.data.filter(payment => payment.status === 'succeeded');

        if (successfulPayments.length > 0) {
          console.log(
            `Found customer with successful payments: ${customer.id} (${customer.email})`
          );

          // Get payment methods count
          const paymentMethods = await client.paymentMethods.list({
            customer: customer.id,
            type: 'card',
          });

          results.customersWithPayments.push({
            customerId: customer.id,
            kiloUserId: customer.metadata.kiloUserId,
            email: customer.email,
            paymentMethodCount: paymentMethods.data.length,
            successfulPaymentsCount: successfulPayments.length,
          });
        }
      }

      // Log progress every 100 customers
      if (processedCustomers % 100 === 0) {
        console.log(`Processed ${processedCustomers} customers so far...`);
      }
    }

    hasMore = customers.has_more;
    startingAfter = customers.data[customers.data.length - 1]?.id;
  }

  results.total = results.customersWithPayments.length;

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total customers processed: ${processedCustomers}`);
  console.log(`Customers with payment methods: ${results.total}`);

  // Write detailed results to a log file
  const logFilePath = path.join(process.cwd(), 'stripe-customers-with-payments.json');
  fs.writeFileSync(logFilePath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results written to: ${logFilePath}`);

  // Output just the kiloUserIds to a separate file for easy copying
  const kiloUserIds = results.customersWithPayments.map(c => c.kiloUserId);
  const idsFilePath = path.join(process.cwd(), 'kilo-user-ids-with-payments.json');
  fs.writeFileSync(idsFilePath, JSON.stringify(kiloUserIds, null, 2));
  console.log(`KiloUserIds written to: ${idsFilePath}`);

  // Output a simple array format
  const simpleIdsFilePath = path.join(process.cwd(), 'kilo-user-ids-list.json');
  fs.writeFileSync(simpleIdsFilePath, JSON.stringify(kiloUserIds));
  console.log(`Simple KiloUserIds list written to: ${simpleIdsFilePath}`);

  return results;
}

// Run the process
listCustomersWithPayments().catch(error => {
  console.error('An error occurred:', error);
  process.exit(1);
});
