import type Stripe from 'stripe';

function referenceId(reference: string | { id: string } | null | undefined): string | null {
  return typeof reference === 'string' ? reference : (reference?.id ?? null);
}

export async function getStripeInvoiceChargeId(
  stripe: Stripe,
  invoice: Stripe.Invoice
): Promise<string | null> {
  const page =
    invoice.payments?.has_more === false
      ? invoice.payments
      : await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 2 });
  const payments = page.data.filter(payment => payment.status === 'paid');
  if (page.has_more || payments.length > 1) return null;
  const payment = payments[0]?.payment;
  if (!payment) return null;
  if (payment.type === 'charge') return referenceId(payment.charge);
  if (payment.type !== 'payment_intent' || !payment.payment_intent) return null;
  const intent =
    typeof payment.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(payment.payment_intent)
      : payment.payment_intent;
  return referenceId(intent.latest_charge);
}

export async function getStripeChargeInvoice(
  stripe: Pick<Stripe, 'invoicePayments'>,
  charge: Pick<Stripe.Charge, 'payment_intent'>
): Promise<Stripe.Invoice | null> {
  const paymentIntentId = referenceId(charge.payment_intent);
  if (!paymentIntentId) return null;
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    expand: ['data.invoice'],
    limit: 2,
  });
  const invoices = new Map<string, Stripe.Invoice>();
  for (const payment of payments.data) {
    const invoice = payment.invoice;
    if (typeof invoice !== 'string' && !('deleted' in invoice)) invoices.set(invoice.id, invoice);
  }
  if (payments.has_more || invoices.size > 1) {
    throw new Error(`PaymentIntent ${paymentIntentId} pays multiple invoices`);
  }
  return invoices.values().next().value ?? null;
}
