import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type LoadingCardProps = {
  title: string;
  description: string;
  rowCount?: number;
};

export function LoadingCard({ title, description, rowCount = 3 }: LoadingCardProps) {
  const getSkeletonBlock = (index: number) => {
    const blockType = index % 3;

    switch (blockType) {
      case 0:
        return (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        );
      case 1:
        return (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        );
      case 2:
        return (
          <div key={index} className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: rowCount }, (_, index) => getSkeletonBlock(index))}
      </CardContent>
    </Card>
  );
}
