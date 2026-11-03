let visible = 0;

export function setStepUpInterstitialVisible(next: boolean): void {
  visible += next ? 1 : -1;
  if (visible < 0) visible = 0;
}

export function isStepUpInterstitialVisible(): boolean {
  return visible > 0;
}
