export function DiscountedPrice({
  price,
  originalPrice,
  formatPrice,
}: {
  price: string;
  originalPrice: string | undefined;
  formatPrice: (raw: string) => string;
}) {
  if (originalPrice === undefined) {
    return <>{formatPrice(price)}</>;
  }

  return (
    <span className="flex flex-col">
      <s className="text-muted-foreground text-xs">
        <span className="sr-only">Original price </span>
        {formatPrice(originalPrice)}
      </s>
      <span className="font-medium">
        <span className="sr-only">Discounted price </span>
        {formatPrice(price)}
      </span>
    </span>
  );
}
