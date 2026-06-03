import type { Metadata } from 'next';

import { PrivacyPolicyContent } from './PrivacyPolicyContent';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for Kilo Code',
};

export default function PrivacyPage() {
  return (
    <main className="bg-background min-h-screen px-4 py-10 sm:px-6">
      <PrivacyPolicyContent />
    </main>
  );
}
