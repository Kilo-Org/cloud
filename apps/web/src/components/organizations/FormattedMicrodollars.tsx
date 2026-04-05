import { formatMicrodollars } from '@/lib/admin-utils';

type FormattedMicrodollarsProps = {
  microdollars: number;
  className?: string;
  inline?: boolean;
  decimalPlaces?: number;
};

export function FormattedMicrodollars({
  microdollars,
  className,
  inline = false,
  decimalPlaces = 4,
}: FormattedMicrodollarsProps) {
  const content = formatMicrodollars(microdollars, decimalPlaces);
  const Elem = inline ? 'span' : 'p';
  return <Elem className={className}>{content}</Elem>;
}
