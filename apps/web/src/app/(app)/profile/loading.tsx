import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Coins, CreditCard } from 'lucide-react';
import { PageLayout } from '@/components/PageLayout';

export default function ProfileLoading() {
  return (
    <PageLayout title="Profile">
      {/* User Info and Credits Cards */}
      <div className="flex w-full flex-col gap-4 lg:flex-row">
        {/* User Info Card */}
        <Card className="flex-1 rounded-xl shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-center space-x-4">
              <Skeleton className="h-14 w-14 rounded-full" /> {/* Avatar */}
              <div className="flex-1 space-y-2">
                <Skeleton className="h-7 w-40" /> {/* Name */}
                <div className="flex items-center">
                  <Skeleton className="h-4 w-48" /> {/* Email */}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Credits Card */}
        <Card className="flex-1 rounded-xl shadow-sm">
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-48" /> {/* Title */}
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-[35.5px] w-32" /> {/* Credits counter */}
          </CardContent>
        </Card>
      </div>

      {/* Organizations Section */}
      <Card className="w-full rounded-xl shadow-sm">
        <CardHeader>
          <Skeleton className="h-6 w-32" /> {/* Section title */}
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" /> {/* Org avatar */}
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-32" /> {/* Org name */}
                    <Skeleton className="h-4 w-24" /> {/* Member count */}
                  </div>
                </div>
                <Skeleton className="h-9 w-20" /> {/* Action button */}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Credit Purchase Options */}
      <div className="flex w-full flex-col gap-4 xl:flex-row xl:items-stretch">
        <div className="flex-3">
          <Card className="w-full">
            <CardHeader>
              <Skeleton className="h-6 w-40" /> {/* Title */}
              <Skeleton className="mt-2 h-4 w-full" /> {/* Description */}
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }, (_, index) => (
                  <Card key={index} className="relative">
                    <CardContent className="p-4">
                      <div className="space-y-3">
                        <Skeleton className="h-8 w-24" /> {/* Price */}
                        <Skeleton className="h-4 w-32" /> {/* Credits amount */}
                        <Skeleton className="h-10 w-full" /> {/* Purchase button */}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Payment Details Card */}
      <div className="flex w-full flex-col gap-4 xl:flex-row xl:items-stretch">
        <div className="flex-3">
          <Card className="h-full w-full text-left">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Payment Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-10 w-48" /> {/* Remove payment method button */}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Auto Top-Up Card */}
      <Card className="w-full text-left">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Automatic Top Up
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-10 w-full max-w-xs" /> {/* Toggle */}
            <Skeleton className="h-4 w-64" /> {/* Description */}
          </div>
        </CardContent>
      </Card>

      {/* Redeem Promo Code Card */}
      <Card className="w-full">
        <CardHeader>
          <Skeleton className="h-6 w-40" /> {/* Title */}
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Skeleton className="h-10 flex-1" /> {/* Input field */}
            <Skeleton className="h-10 w-24" /> {/* Submit button */}
          </div>
        </CardContent>
      </Card>

      {/* Integrations Card */}
      <Card className="w-full">
        <CardHeader>
          <Skeleton className="h-6 w-32" /> {/* Title */}
          <Skeleton className="mt-2 h-4 w-full" /> {/* Description */}
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 2 }, (_, index) => (
              <div key={index} className="flex items-center justify-between rounded-lg border p-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded" /> {/* Icon */}
                  <Skeleton className="h-5 w-32" /> {/* Integration name */}
                </div>
                <Skeleton className="h-9 w-24" /> {/* Action button */}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </PageLayout>
  );
}
