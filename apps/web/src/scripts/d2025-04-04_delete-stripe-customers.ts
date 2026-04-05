import { getEnvVariable } from '@/lib/dotenvx';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';

// Initialize Stripe client
const client = new Stripe(getEnvVariable('STRIPE_SECRET_KEY'));

// User ID to look for
const KILO_USER_IDS: string[] = [];

interface ProcessResults {
  success: number;
  notFound: number;
  failed: number;
  details: {
    customerId: string;
    email: string | null;
    status: 'success' | 'failed';
    error?: string;
  }[];
}

async function deleteCustomers() {
  console.log('Starting customer deletion process...');
  let processedCustomers = 0;

  const results: ProcessResults = {
    success: 0,
    notFound: 0,
    failed: 0,
    details: [],
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

      // Check if this customer has matching metadata
      if (KILO_USER_IDS.includes(customer.metadata?.kiloUserId)) {
        console.log(`Found matching customer: ${customer.id} (${customer.email})`);

        try {
          // Check for payment methods
          const paymentMethods = await client.paymentMethods.list({
            customer: customer.id,
            type: 'card',
          });

          if (paymentMethods.data.length > 0) {
            console.log(
              `Skipping customer ${customer.id} - has ${paymentMethods.data.length} payment methods`
            );
            results.details.push({
              customerId: customer.id,
              email: customer.email,
              status: 'failed',
              error: 'Customer has active payment methods',
            });
            results.failed++;
            continue;
          }

          // Delete the customer
          await client.customers.del(customer.id);

          console.log(`Successfully deleted customer: ${customer.id} (${customer.email})`);
          results.success++;
          results.details.push({
            customerId: customer.id,
            email: customer.email,
            status: 'success',
          });
        } catch (error) {
          console.error(`Failed to delete customer ${customer.id}:`, error);
          results.failed++;
          results.details.push({
            customerId: customer.id,
            email: customer.email,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
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

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log(`Total customers processed: ${processedCustomers}`);
  console.log(`Successfully deleted: ${results.success}`);
  console.log(`Failed to delete: ${results.failed}`);

  // Write detailed results to a log file
  const logFilePath = path.join(process.cwd(), 'stripe-customer-deletion-results.json');
  fs.writeFileSync(logFilePath, JSON.stringify(results, null, 2));
  console.log(`\nDetailed results written to: ${logFilePath}`);

  return results;
}

// Run the deletion process
deleteCustomers().catch(error => {
  console.error('An error occurred:', error);
  process.exit(1);
});
