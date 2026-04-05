// consider using customer data downloads instead in the stripe UI

import { getEnvVariable } from '@/lib/dotenvx';
import Stripe from 'stripe';
import fs from 'fs';

const client = new Stripe(getEnvVariable('STRIPE_SECRET_KEY'));

interface PaymentMethodAnalysis {
  customerId: string;
  paymentMethodId: string;
  addressLineCheckPassed: boolean | null;
  cvcCheckPassed: boolean | null;
  postalCodeCheckPassed: boolean | null;
  funding: string | null;
  threeDSecureCheckSupported: boolean | null;
  country: string | null;
  brand: string | null;
  last4: string | null;
}

async function analyzePaymentMethods() {
  const results: PaymentMethodAnalysis[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;
  let processedCustomers = 0;
  let processedPaymentMethods = 0;

  console.log('Starting payment methods analysis...');

  while (hasMore) {
    const customers = await client.customers.list({
      limit: 100,
      starting_after: startingAfter,
    });

    for (const customer of customers.data) {
      processedCustomers++;
      const paymentMethods = await client.paymentMethods.list({
        customer: customer.id,
        type: 'card',
      });

      for (const pm of paymentMethods.data) {
        processedPaymentMethods++;
        results.push({
          customerId: customer.id,
          paymentMethodId: pm.id,
          addressLineCheckPassed: pm.card?.checks?.address_line1_check === 'pass',
          cvcCheckPassed: pm.card?.checks?.cvc_check === 'pass',
          postalCodeCheckPassed: pm.card?.checks?.address_postal_code_check === 'pass',
          funding: pm.card?.funding || null,
          threeDSecureCheckSupported: pm.card?.three_d_secure_usage?.supported || null,
          country: pm.card?.country || null,
          brand: pm.card?.brand || null,
          last4: pm.card?.last4 || null,
        });
      }

      // Log progress every 100 customers
      if (processedCustomers % 100 === 0) {
        console.log(
          `Processed ${processedCustomers} customers, ${processedPaymentMethods} payment methods so far...`
        );
      }
    }

    hasMore = customers.has_more;
    startingAfter = customers.data[customers.data.length - 1]?.id;
  }

  console.log('\nAnalysis complete!');
  console.log(`Total customers processed: ${processedCustomers}`);
  console.log(`Total payment methods processed: ${processedPaymentMethods}`);

  // Write results to a JSON file
  fs.writeFileSync('payment-methods-analysis.json', JSON.stringify(results, null, 2));

  // Print summary statistics
  console.log(`Total payment methods analyzed: ${results.length}`);
  console.log('Summary:');
  console.log('3DS Supported:', results.filter(r => r.threeDSecureCheckSupported).length);
  console.log('Address Check Passed:', results.filter(r => r.addressLineCheckPassed).length);
  console.log('CVC Check Passed:', results.filter(r => r.cvcCheckPassed).length);
  console.log('Postal Code Check Passed:', results.filter(r => r.postalCodeCheckPassed).length);
}

// Run the analysis
analyzePaymentMethods().catch(console.error);
