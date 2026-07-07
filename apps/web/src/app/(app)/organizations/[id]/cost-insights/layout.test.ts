import type { ReactElement, ReactNode } from 'react';

const mockIsReleaseToggleEnabled = jest.fn<Promise<boolean>, [string, string]>();

function renderElement<Props, Result>(element: ReactElement<Props>): Result {
  return (element.type as (props: Props) => Result)(element.props);
}

jest.mock('@/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: (flagName: string, distinctId: string) =>
    mockIsReleaseToggleEnabled(flagName, distinctId),
}));

jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

jest.mock('@/components/cost-insights/CostInsightsLayout', () => ({
  CostInsightsLayout: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/components/organizations/OrganizationByPageLayout', () => ({
  OrganizationByPageLayout: (props: {
    render: (params: {
      organization: { id: string };
      role: 'owner' | 'billing_manager';
      isGlobalAdmin: boolean;
    }) => ReactElement;
  }) =>
    props.render({
      organization: { id: 'org-cost-insights-layout' },
      role: 'owner',
      isGlobalAdmin: false,
    }),
}));

describe('OrganizationCostInsightsLayout', () => {
  beforeEach(() => {
    mockIsReleaseToggleEnabled.mockReset();
  });

  it('renders for non-admin organization owners when the organization flag is enabled', async () => {
    mockIsReleaseToggleEnabled.mockResolvedValue(true);
    const { default: OrganizationCostInsightsLayout } =
      await import('@/app/(app)/organizations/[id]/cost-insights/layout');

    const layoutElement = OrganizationCostInsightsLayout({
      params: Promise.resolve({ id: 'org-cost-insights-layout' }),
      children: 'cost insights content',
    }) as ReactElement<{ children: ReactNode }>;
    const guardElement = renderElement(layoutElement) as ReactElement<{
      organizationId: string;
      children: ReactNode;
    }>;

    const costInsightsLayoutElement = (await renderElement(guardElement)) as ReactElement<{
      basePath: string;
      children: ReactNode;
    }>;
    expect(costInsightsLayoutElement.props).toMatchObject({
      basePath: '/organizations/org-cost-insights-layout/cost-insights',
      children: 'cost insights content',
    });
    expect(mockIsReleaseToggleEnabled).toHaveBeenCalledWith(
      'cost-insights',
      'org-cost-insights-layout'
    );
  });

  it('not-founds when the organization flag is disabled', async () => {
    mockIsReleaseToggleEnabled.mockResolvedValue(false);
    const { default: OrganizationCostInsightsLayout } =
      await import('@/app/(app)/organizations/[id]/cost-insights/layout');

    const layoutElement = OrganizationCostInsightsLayout({
      params: Promise.resolve({ id: 'org-cost-insights-layout' }),
      children: 'cost insights content',
    }) as ReactElement<{ children: ReactNode }>;
    const guardElement = renderElement(layoutElement) as ReactElement<{
      organizationId: string;
      children: ReactNode;
    }>;

    await expect(Promise.resolve(renderElement(guardElement))).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
