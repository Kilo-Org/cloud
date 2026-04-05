'use client';
import MetaLogo from '@/components/assets/MetaLogo';
import AmazonLogo from '@/components/assets/AmazonLogo';
import AirbnbLogo from '@/components/assets/AirbnbLogo';
import PayPalLogo from '@/components/assets/PayPalLogo';
import SquareLogo from '@/components/assets/SquareLogo';
import { cn } from '@/lib/utils';
import { motion } from 'motion/react';

type CompanyProps = {
  name: string;
  logo: string | React.ReactNode;
  className?: string;
};

const companies: CompanyProps[] = [
  {
    name: 'Meta',
    logo: <MetaLogo />,
  },
  {
    name: 'Amazon',
    logo: <AmazonLogo />,
  },
  {
    name: 'Airbnb',
    logo: <AirbnbLogo />,
  },
  {
    name: 'PayPal',
    logo: <PayPalLogo />,
  },
  {
    name: 'Square',
    logo: <SquareLogo />,
  },
];

type LogosSectionProps = {
  title?: string;
  className?: string;
};

export default function LogosSection({ className }: LogosSectionProps) {
  return (
    <div className={cn('flex flex-col gap-4 pb-10', className)}>
      <div className="flex flex-wrap items-center justify-center gap-4 md:gap-6 lg:gap-8">
        {companies.slice(0, 7).map((company, index) => (
          <motion.div
            key={index}
            tabIndex={-1}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.3, delay: index * 0.1 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="group/logo flex items-center justify-center"
          >
            <div
              className={cn(
                'flex items-center justify-center transition-all duration-300',
                'max-h-12 max-w-20',
                'grayscale group-hover/logo:grayscale-0',
                'opacity-60 group-hover/logo:opacity-100',
                '[&_svg]:h-auto [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:max-w-full',
                '[&_svg_path]:transition-all [&_svg_path]:duration-300',
                '[&_svg_path]:fill-[#A1A1A1]',
                'group-hover/logo:[&_svg_path]:fill-brand-primary'
              )}
            >
              {company.logo}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
