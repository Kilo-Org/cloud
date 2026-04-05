import { Button } from '@/components/ui/button';
import Image from 'next/image';

export const OpenInExtensionButton = ({
  children,
  className = '',
  ideName,
  logoSrc,
  source,
}: {
  className?: string;
  children?: React.ReactNode;
  ideName: string;
  logoSrc?: string;
  source?: string;
}) => {
  const interstitialUrl = source ? `/sign-in-to-editor?source=${source}` : `/sign-in-to-editor`;

  return (
    <Button asChild variant="outline" className={className}>
      <a target="_blank" href={interstitialUrl} className="inline-flex items-center gap-4">
        {logoSrc && (
          <Image
            src={logoSrc}
            alt={`${ideName} Logo`}
            className="mr-2 aspect-square"
            height={32}
            width={32}
          />
        )}
        {children ? children : <>Open in {ideName}</>}
      </a>
    </Button>
  );
};
