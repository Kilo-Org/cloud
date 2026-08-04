import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type SubOrganizationsSectionPlaceholderProps = {
  /** Anchor id so deep links and later beads can target this slot. */
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  /**
   * Optional node rendered in place of the default placeholder body. Later
   * convoy beads pass their implemented section content here without touching
   * the surrounding page layout.
   */
  children?: ReactNode;
};

/**
 * A named, stable slot in the sub-organizations surface. The scaffold renders
 * a placeholder body for every dimension (People, Usage, Credits, Models,
 * Permissions); subsequent beads replace the body by passing `children` (or by
 * swapping this component for a concrete section) without restructuring the
 * page.
 */
export function SubOrganizationsSectionPlaceholder({
  id,
  title,
  description,
  icon: Icon,
  children,
}: SubOrganizationsSectionPlaceholderProps) {
  return (
    <Card id={id} data-slot="sub-organizations-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {children ?? (
          <div className="text-muted-foreground rounded-lg border border-dashed py-10 text-center text-sm">
            {description}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
