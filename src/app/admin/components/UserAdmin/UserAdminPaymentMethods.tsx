'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, CreditCard } from 'lucide-react';
import type { UserDetailProps } from '@/types/admin';
import type { PaymentMethod } from '@kilocode/db/schema';
import { formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';

type AdminPaymentMethod = PaymentMethod;

function getStripeFingerprintSearchUrl(fingerprint: string) {
  const envPrefix = process.env.NODE_ENV === 'development' ? 'test/' : '';
  const query = encodeURIComponent(`fingerprint:${fingerprint}`);
  return `https://dashboard.stripe.com/${envPrefix}search?query=${query}`;
}

export function UserAdminPaymentMethods({ id }: UserDetailProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-user-payment-methods', id],
    queryFn: async (): Promise<{ payment_methods: AdminPaymentMethod[] }> => {
      const response = await fetch(`/admin/api/users/payment-methods?kilo_user_id=${id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch payment methods');
      }
      return (await response.json()) as { payment_methods: AdminPaymentMethod[] };
    },
  });

  const methods = data?.payment_methods ?? [];
  const total = methods.length;
  const deletedCount = methods.filter(pm => pm.deleted_at != null).length;
  const activeCount = total - deletedCount;

  return (
    <Card className="max-h-max lg:col-span-2 lg:row-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5" /> Payment Methods
        </CardTitle>
        <CardDescription>
          All payment methods for this user, including soft-deleted. Payment methods that the user
          chose not to store may not be included.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading payment methods...</p>
        ) : error ? (
          <p className="text-sm text-red-600">Failed to load payment methods</p>
        ) : total > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              Total: {total} • Active: {activeCount} • Soft-deleted: {deletedCount}
            </p>
            <div className="bg-muted/50 rounded-md border">
              <div className="space-y-0">
                {methods.map(method => {
                  const isDeleted = method.deleted_at != null;
                  const title = [
                    method.brand ?? 'Unknown brand',
                    method.last4 ? `•••• ${method.last4}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  const addressParts = [
                    method.address_line1,
                    method.address_line2,
                    method.address_city,
                    [method.address_state, method.address_zip].filter(Boolean).join(' '),
                    method.address_country,
                  ]
                    .filter(Boolean)
                    .join(', ')
                    .replace(/, ,/g, ',');

                  return (
                    <div
                      key={method.id}
                      className={[
                        'border-muted/30 border-b p-3 last:border-b-0',
                        isDeleted ? 'bg-red-50/80' : '',
                      ].join(' ')}
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p
                              className={[
                                'text-sm font-medium',
                                isDeleted ? 'line-through opacity-70' : '',
                              ].join(' ')}
                            >
                              {title || 'Payment Method'}
                            </p>
                            <p className="text-muted-foreground text-xs">{method.name ?? '—'}</p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {isDeleted ? (
                              <Badge className="bg-red-100 text-red-800">Soft-deleted</Badge>
                            ) : (
                              <Badge
                                variant="secondary"
                                className="bg-emerald-100 text-emerald-800"
                              >
                                Active
                              </Badge>
                            )}
                            {method.three_d_secure_supported != null && (
                              <Badge className="bg-purple-100 text-purple-800">
                                3DS: {method.three_d_secure_supported ? 'Yes' : 'No'}
                              </Badge>
                            )}
                            {method.type && (
                              <Badge className="text-foreground bg-gray-100">{method.type}</Badge>
                            )}
                            {method.funding && (
                              <Badge className="text-foreground bg-gray-100">
                                {method.funding}
                              </Badge>
                            )}
                            {method.regulated_status && (
                              <Badge className="bg-amber-100 text-amber-800">
                                {method.regulated_status}
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="text-muted-foreground grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
                          <div className="flex flex-wrap items-center gap-3">
                            <span>
                              Created:{' '}
                              <span className="text-foreground">
                                {formatIsoDateString_UsaDateOnlyFormat(method.created_at)}
                              </span>
                            </span>
                            <span>
                              Updated:{' '}
                              <span className="text-foreground">
                                {formatIsoDateString_UsaDateOnlyFormat(method.updated_at)}
                              </span>
                            </span>
                            {isDeleted && (
                              <span className="text-red-700">
                                Deleted:{' '}
                                <span className="text-foreground">
                                  {formatIsoDateString_UsaDateOnlyFormat(method.deleted_at)}
                                </span>
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-3">
                            {method.stripe_id && (
                              <span className="text-foreground">Stripe PM: {method.stripe_id}</span>
                            )}
                            {method.stripe_fingerprint && (
                              <a
                                href={getStripeFingerprintSearchUrl(method.stripe_fingerprint)}
                                target="_blank"
                                className="flex items-center gap-1 text-blue-600 underline hover:text-blue-800"
                              >
                                Fingerprint: {method.stripe_fingerprint}
                                <ExternalLinkIcon className="h-3 w-3" />
                              </a>
                            )}
                          </div>

                          <div className="col-span-full flex flex-wrap items-center gap-3">
                            {addressParts ? (
                              <span className="text-foreground">Billing: {addressParts}</span>
                            ) : (
                              <span>Billing: —</span>
                            )}
                          </div>

                          <div className="col-span-full flex flex-wrap items-center gap-3">
                            {method.http_x_forwarded_for && (
                              <span className="text-foreground">
                                XFF: {method.http_x_forwarded_for}
                              </span>
                            )}
                            {(method.http_x_vercel_ip_city || method.http_x_vercel_ip_country) && (
                              <span className="text-foreground">
                                Geo:{' '}
                                {[method.http_x_vercel_ip_city, method.http_x_vercel_ip_country]
                                  .filter(Boolean)
                                  .join(', ')}
                              </span>
                            )}
                            {method.http_x_vercel_ja4_digest && (
                              <span className="text-foreground">
                                JA4: {method.http_x_vercel_ja4_digest}
                              </span>
                            )}
                          </div>

                          <div className="col-span-full flex flex-wrap items-center gap-3">
                            <span>
                              Scope:{' '}
                              <span className="text-foreground">
                                {method.organization_id
                                  ? `Organization (${method.organization_id})`
                                  : 'User'}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No payment methods found for this user.</p>
        )}
      </CardContent>
    </Card>
  );
}
