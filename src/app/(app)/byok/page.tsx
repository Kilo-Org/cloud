'use client';

import { PageLayout } from '@/components/PageLayout';
import { BYOKKeysManager } from '@/components/organizations/byok/BYOKKeysManager';

export default function PersonalBYOKPage() {
  return (
    <PageLayout title="Bring Your Own Key">
      <BYOKKeysManager />
    </PageLayout>
  );
}
