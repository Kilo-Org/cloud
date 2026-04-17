import { SafetyIdentifiersBackfill } from '../components/SafetyIdentifiersBackfill';
import { NormalizedEmailBackfill } from '../components/NormalizedEmailBackfill';
import { BlockBlacklistedDomainsBackfill } from '../components/BlockBlacklistedDomainsBackfill';
import { SafetyIdentifierHashGenerator } from '../components/SafetyIdentifierHashGenerator';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Backfills</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function BackfillsPage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Normalized Email Backfill</h2>
        </div>
        <NormalizedEmailBackfill />
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Block Blacklisted Domains</h2>
        </div>
        <BlockBlacklistedDomainsBackfill />
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Safety Identifier Backfill</h2>
        </div>
        <SafetyIdentifiersBackfill />
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Hash Generator</h2>
        </div>
        <SafetyIdentifierHashGenerator />
      </div>
    </AdminPage>
  );
}
