import MetaLogo from '@/components/assets/MetaLogo';
import AmazonLogo from '@/components/assets/AmazonLogo';
import AirbnbLogo from '@/components/assets/AirbnbLogo';
import PayPalLogo from '@/components/assets/PayPalLogo';
import SquareLogo from '@/components/assets/SquareLogo';
import { cn } from '@/lib/utils';

type CompanyProps = {
  name: string;
  logo: React.ReactNode;
};

const companies: CompanyProps[] = [
  { name: 'Meta', logo: <MetaLogo /> },
  { name: 'Amazon', logo: <AmazonLogo /> },
  { name: 'Airbnb', logo: <AirbnbLogo /> },
  { name: 'PayPal', logo: <PayPalLogo /> },
  { name: 'Square', logo: <SquareLogo /> },
];

type LogosSectionProps = {
  className?: string;
};

export default function LogosSection({ className }: LogosSectionProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex w-full items-center justify-between gap-2 opacity-75">
        {companies.map(company => (
          <div
            key={company.name}
            aria-label={company.name}
            className={cn(
              // Equal-flex box so every logo gets the same horizontal share of the row,
              // and shrinks together as the container narrows. Tall enough that
              // squarer marks (Meta) read at a similar visual weight to wider ones (Square).
              'flex h-8 min-w-0 flex-1 items-center justify-center',
              // SVG fills box up to caps; aspect ratio preserved.
              '[&_svg]:h-auto [&_svg]:max-h-7 [&_svg]:w-auto [&_svg]:max-w-full',
              '[&_svg_path]:fill-foreground'
            )}
          >
            {company.logo}
          </div>
        ))}
      </div>
    </div>
  );
}
