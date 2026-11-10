'use client';

import { LogExportForm } from '@/app/admin/components/LogExportForm';

export function ProviderMetadataContent() {
  return (
    <div className="w-full max-w-3xl">
      <LogExportForm
        title="Download Provider Metadata"
        description={
          <>
            The routing decision, Vercel provider metadata, and Enkrypt input and output guardrail
            reports stored for each matching usage record.
          </>
        }
        downloadPath="/admin/api/provider-metadata/download"
        idLabel="Usage ID"
        idPlaceholder="Enter usage UUID"
      />
    </div>
  );
}
