export type PrependScrollAnchorSnapshot = {
  scrollHeight: number;
  scrollTop: number;
};

export type ScrollAnchorElement = {
  readonly scrollHeight: number;
  scrollTop: number;
};

export function capturePrependScrollAnchor(el: ScrollAnchorElement): PrependScrollAnchorSnapshot {
  return {
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
  };
}

export function applyPrependScrollAnchor(
  el: ScrollAnchorElement,
  snapshot: PrependScrollAnchorSnapshot
) {
  const heightDelta = el.scrollHeight - snapshot.scrollHeight;
  el.scrollTop = snapshot.scrollTop + heightDelta;
}
