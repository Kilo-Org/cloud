'use client';

import { LogExportForm } from '@/app/admin/components/LogExportForm';

export function ProviderMetadataContent() {
  return (
    <div className="w-full max-w-xl">
      <LogExportForm
        title="Download Provider Metadata"
        description={
          <>
            Exports the AI provider metadata object stored in R2 for each matching{' '}
            <code>microdollar_usage</code> row: the gateway routing decision, Vercel provider
            metadata, and Enkrypt guardrail reports.
          </>
        }
        downloadPath="/admin/api/provider-metadata/download"
        idLabel="Usage ID"
        idPlaceholder="Enter microdollar_usage UUID"
      />
    </div>
  );
}
