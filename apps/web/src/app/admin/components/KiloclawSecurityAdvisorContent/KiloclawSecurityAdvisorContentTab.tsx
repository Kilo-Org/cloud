'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CheckCatalogPanel } from './CheckCatalogPanel';
import { KiloclawCoveragePanel } from './KiloclawCoveragePanel';
import { ContentKeysPanel } from './ContentKeysPanel';

const VALID_SUBTABS: readonly string[] = ['catalog', 'coverage', 'content'];
type Subtab = 'catalog' | 'coverage' | 'content';
const isValidSubtab = (value: string | null): value is Subtab =>
  value !== null && VALID_SUBTABS.includes(value);

const tabTriggerClass =
  'text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground rounded-none border-b-2 border-transparent px-0 py-2 text-sm font-medium transition-colors data-[state=active]:border-0 data-[state=active]:border-b-2 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function KiloclawSecurityAdvisorContentTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const subtabParam = searchParams.get('subtab');
  const activeSubtab: Subtab = isValidSubtab(subtabParam) ? subtabParam : 'catalog';

  const onSubtabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === 'catalog') {
        params.delete('subtab');
      } else {
        params.set('subtab', value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  return (
    <div className="flex w-full flex-col gap-y-4">
      <div>
        <h2 className="text-xl font-bold">Security Advisor Content</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Customer-visible text for the security advisor report, organized into three tabs:
        </p>
        <ul className="text-muted-foreground mt-2 list-disc pl-5 text-sm">
          <li>
            <strong>Check Catalog</strong> — definitions of each security finding we recognize
            (severity, explanation, risk).
          </li>
          <li>
            <strong>KiloClaw Coverage</strong> — how KiloClaw handles each area, attached to
            matching findings in the report.
          </li>
          <li>
            <strong>Content Keys</strong> — the editable chrome (CTA, framing templates, fallback
            text) shown around the findings.
          </li>
        </ul>
        <p className="text-muted-foreground mt-2 text-sm">
          Edits take effect within 5 minutes on each replica (in-process cache TTL).
        </p>
      </div>
      <Tabs value={activeSubtab} onValueChange={onSubtabChange}>
        <TabsList className="h-auto w-full justify-start gap-6 rounded-none border-b bg-transparent p-0">
          <TabsTrigger value="catalog" className={tabTriggerClass}>
            Check Catalog
          </TabsTrigger>
          <TabsTrigger value="coverage" className={tabTriggerClass}>
            KiloClaw Coverage
          </TabsTrigger>
          <TabsTrigger value="content" className={tabTriggerClass}>
            Content Keys
          </TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="mt-4">
          <CheckCatalogPanel />
        </TabsContent>
        <TabsContent value="coverage" className="mt-4">
          <KiloclawCoveragePanel />
        </TabsContent>
        <TabsContent value="content" className="mt-4">
          <ContentKeysPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
