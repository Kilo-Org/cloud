import type { Metadata } from 'next';

import { fetchPrivacyPolicyMainHtml } from './privacy-policy-source';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'Privacy Policy for Kilo Code',
  robots: {
    index: false,
    follow: true,
  },
};

export const revalidate = 3600;

export default async function PrivacyAppPage() {
  const policyHtml = await fetchPrivacyPolicyMainHtml();

  return (
    <main className="bg-background min-h-screen px-4 py-6 sm:px-6">
      <div
        className="prose prose-invert prose-headings:text-foreground prose-p:text-muted-foreground prose-li:text-muted-foreground prose-a:text-primary mx-auto max-w-3xl"
        dangerouslySetInnerHTML={{ __html: policyHtml }}
      />
    </main>
  );
}
