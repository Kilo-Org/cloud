import { CostInsightsLayout } from '@/components/cost-insights/CostInsightsLayout';

export const metadata = {
  title: 'Cost Insights | Kilo Code',
  description: 'Review Credit spend and configure Spend Alerts',
};

export default function CostInsightsRootLayout({ children }: { children: React.ReactNode }) {
  return <CostInsightsLayout basePath="/cost-insights">{children}</CostInsightsLayout>;
}
