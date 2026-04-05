export type UnifiedInvoice = {
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  invoice_type?: 'seats' | 'topup';
  description?: string | null;
};
