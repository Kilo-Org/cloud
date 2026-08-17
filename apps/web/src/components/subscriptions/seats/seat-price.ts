export type SeatPriceLineItem = {
  id: string;
  quantity?: number | null;
  price?: {
    product?: unknown;
    unit_amount?: number | null;
    recurring?: { interval?: string | null } | null;
  } | null;
};

function getProductId(item: SeatPriceLineItem | null): string | null {
  const product = item?.price?.product;
  return typeof product === 'string' && product.trim() !== '' ? product : null;
}

function getItemAmountCents(item: SeatPriceLineItem): number {
  return (item.price?.unit_amount ?? 0) * (item.quantity ?? 0);
}

export function getSeatPriceLineItems(
  items: readonly SeatPriceLineItem[],
  paidSeatItemId: string | null
): SeatPriceLineItem[] {
  const paidSeatItem = paidSeatItemId
    ? (items.find(item => item.id === paidSeatItemId) ?? null)
    : null;
  if (!paidSeatItem) return [];

  const paidProductId = getProductId(paidSeatItem);
  if (!paidProductId) return [paidSeatItem];

  return items.filter(item => item.id === paidSeatItem.id || getProductId(item) === paidProductId);
}

export function getSeatPriceInterval(
  paidSeatItem: Pick<SeatPriceLineItem, 'price'> | null
): 'month' | 'year' {
  return paidSeatItem?.price?.recurring?.interval === 'year' ? 'year' : 'month';
}

export function formatSeatPrice(
  items: readonly SeatPriceLineItem[],
  paidSeatItemId: string | null
): string {
  const seatItems = getSeatPriceLineItems(items, paidSeatItemId);
  const paidSeatItem = paidSeatItemId
    ? (seatItems.find(item => item.id === paidSeatItemId) ?? null)
    : null;
  const totalAmount = seatItems.reduce((sum, item) => sum + getItemAmountCents(item), 0);
  return `$${(totalAmount / 100).toFixed(2)}/${getSeatPriceInterval(paidSeatItem)}`;
}
