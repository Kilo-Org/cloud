'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate } from '@/lib/admin-utils';
import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import type { UserDetailProps } from '@/types/admin';

function renderValidationBadge(value: boolean | null, className?: string) {
  const baseClasses = `font-semibold ${className ?? ''}`;

  if (value === true) {
    return <span className={`${baseClasses} text-green-600`}>true</span>;
  }
  if (value === false) {
    return <span className={`${baseClasses} text-red-600`}>false</span>;
  }
  return <span className={`${baseClasses} text-gray-500`}>null</span>;
}

function renderVerdictWithReasons(verdictAction: string, reasons: string[] | null) {
  const reasonsList = reasons ?? [];
  const hasReasons = reasonsList.length > 0;

  if (!hasReasons) {
    return <span className="font-semibold">{verdictAction}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help font-semibold">
            {verdictAction} [{reasonsList.length}]
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <ul className="list-disc pl-4">
            {reasonsList.map((reason, idx) => (
              <li key={idx}>{reason}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type FingerprintType =
  | 'visitor_fingerprint'
  | 'browser_fingerprint'
  | 'network_fingerprint'
  | 'hardware_fingerprint';

export function UserAdminStytchFingerprints({ id, has_validation_stytch }: UserDetailProps) {
  const [fingerprintType, setFingerprintType] = useState<FingerprintType>('visitor_fingerprint');
  const trpc = useTRPC();
  const { data, isLoading, isError, refetch } = useQuery(
    trpc.admin.users.getStytchFingerprints.queryOptions({
      kilo_user_id: id,
      fingerprint_type: fingerprintType,
    })
  );

  const renderDateWithFingerprintTooltip = (
    fp: NonNullable<typeof data>['fingerprints'][number]
  ) => {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help underline decoration-dotted">
              {formatDate(fp.created_at)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md">
            <div className="space-y-1 text-xs">
              <div className="font-mono">{fp.visitor_fingerprint}</div>
              <div className="font-mono">{fp.browser_fingerprint}</div>
              <div className="font-mono">{fp.network_fingerprint}</div>
              <div className="font-mono">{fp.hardware_fingerprint}</div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const renderValidationStatus = () => {
    return (
      <div className="mb-3 flex flex-row items-baseline gap-2">
        <h4 className="text-muted-foreground mb-1 text-sm font-medium">has_validation_stytch:</h4>
        {renderValidationBadge(has_validation_stytch, 'text-sm')}
      </div>
    );
  };

  const renderFingerprintsSection = () => {
    const fingerprints = data?.fingerprints ?? [];
    return (
      <>
        <h4 className="text-muted-foreground mb-1 text-sm font-medium">User fingerprints</h4>
        <div className="bg-muted/50 mb-3 max-w-max space-y-1 rounded-md border p-2 text-sm">
          {fingerprints.map((fp, idx) => (
            <div key={idx} className="flex flex-wrap gap-2">
              <span className="text-muted-foreground text-xs">
                {renderDateWithFingerprintTooltip(fp)}
              </span>
              <span className="text-muted-foreground text-xs">
                verdict: {renderVerdictWithReasons(fp.verdict_action, fp.reasons)}
              </span>
              <span className="text-muted-foreground text-xs">
                kilo_free_tier_allowed:{' '}
                <span className="font-semibold">{fp.kilo_free_tier_allowed.toString()}</span>
              </span>
            </div>
          ))}
        </div>
      </>
    );
  };

  const renderRelatedUsersSection = () => {
    const users = data?.relatedUsers ?? [];

    if (users.length === 0) {
      return null;
    }

    const fingerprintTypeLabel = fingerprintType.replace('_fingerprint', '');

    return (
      <>
        <h4 className="text-muted-foreground my-2 text-sm font-medium">
          {users.length >= 100 ? 'First 100' : users.length.toString()} other user
          {users.length !== 1 ? 's' : ''} with same {fingerprintTypeLabel} fingerprint
        </h4>
        <table className="bg-muted/50 max-w-max rounded-md border text-sm">
          <thead>
            <tr>
              <th className="p-2 text-center font-bold">User</th>
              <th className="p-2 text-center font-bold">fingerprinted at</th>
              <th className="p-2 text-center font-bold">stytch verdict</th>
              <th className="p-2 text-center font-bold">kilo allowed</th>
              <th className="p-2 text-center font-bold">user validation</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td className="p-2">
                  <Link
                    href={`/admin/users/${encodeURIComponent(u.kilo_user_id)}`}
                    aria-label={`View admin details for ${u.google_user_name} (${u.google_user_email})`}
                    className="text-blue-600 underline hover:text-blue-800"
                  >
                    {u.google_user_email}
                  </Link>
                </td>
                <td className="text-muted-foreground p-2 text-center">
                  {renderDateWithFingerprintTooltip(u)}
                </td>
                <td className="text-muted-foreground p-2 text-center">
                  {renderVerdictWithReasons(u.verdict_action, u.reasons)}
                </td>
                <td className="p-2 text-center">
                  {renderValidationBadge(u.kilo_free_tier_allowed)}
                </td>
                <td className="p-2 text-center">
                  {renderValidationBadge(u.has_validation_stytch)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  };

  return (
    <Card className="max-h-max lg:col-span-2">
      <CardHeader>
        <CardTitle>Stytch Fingerprinting</CardTitle>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-600">Failed to load Stytch fingerprints</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading Stytch fingerprints...</p>
        ) : (
          <div>
            {renderValidationStatus()}
            {renderFingerprintsSection()}
            <label className="mb-3 flex items-center gap-2">
              <span className="text-muted-foreground text-sm font-medium">
                Find related users by:
              </span>
              <Select
                value={fingerprintType}
                onValueChange={value => setFingerprintType(value as FingerprintType)}
              >
                <SelectTrigger size="sm" className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="visitor_fingerprint">Visitor fingerprint</SelectItem>
                  <SelectItem value="browser_fingerprint">Browser fingerprint</SelectItem>
                  <SelectItem value="network_fingerprint">Network fingerprint</SelectItem>
                  <SelectItem value="hardware_fingerprint">Hardware fingerprint</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {renderRelatedUsersSection()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
