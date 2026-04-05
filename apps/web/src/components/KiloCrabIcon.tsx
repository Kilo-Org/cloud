'use client';

type KiloCrabIconProps = React.ComponentPropsWithoutRef<'span'>;

export default function KiloCrabIcon({ className, style, ...props }: KiloCrabIconProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        backgroundColor: 'currentColor',
        WebkitMaskImage: 'url(/kilocrab.svg)',
        maskImage: 'url(/kilocrab.svg)',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        display: 'inline-block',
        ...style,
      }}
      {...props}
    />
  );
}
