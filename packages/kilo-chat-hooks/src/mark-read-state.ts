export type MarkReadState = {
  lastSucceededMarker: string | null;
  inFlightMarker: string | null;
};

export function createMarkReadState(): MarkReadState {
  return {
    lastSucceededMarker: null,
    inFlightMarker: null,
  };
}

export function shouldStartMarkReadAttempt(state: MarkReadState, marker: string): boolean {
  return state.lastSucceededMarker !== marker && state.inFlightMarker !== marker;
}

export function startMarkReadAttempt(state: MarkReadState, marker: string): void {
  state.inFlightMarker = marker;
}

export function succeedMarkReadAttempt(state: MarkReadState, marker: string): void {
  state.lastSucceededMarker = marker;
}

export function finishMarkReadAttempt(state: MarkReadState, marker: string): void {
  if (state.inFlightMarker === marker) {
    state.inFlightMarker = null;
  }
}
