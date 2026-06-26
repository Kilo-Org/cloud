import { CostInsightsLayout } from '@/components/cost-insights/CostInsightsLayout';
import { getUserFromAuth } from '@/lib/user/server';
import { notFound } from 'next/navigation';

export const metadata = {
  title: 'Cost Insights | Kilo Code',
  description: 'Review Credit spend and configure Spend Alerts',
};

export default async function CostInsightsRootLayout({ children }: { children: React.ReactNode }) {
  const { user } = await getUserFromAuth({ adminOnly: true });
  if (!user) notFound();

  return <CostInsightsLayout basePath="/cost-insights">{children}</CostInsightsLayout>;
}
