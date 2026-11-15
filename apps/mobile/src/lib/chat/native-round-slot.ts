import { type NativeModelBridge } from './native-model-client';

/** A generation that asked for tools and waits, between two rounds, for their results. */
type HeldRound = {
  readonly id: string;
  /** The exchange that owns it: the `cacheKey` its request carried, one per chat. */
  readonly owner: string | undefined;
  readonly calls: readonly string[];
  readonly hasText: boolean;
};

/** The one native generation one bridge holds open between rounds. */
type ToolLoop = { readonly kind: 'free' } | { readonly kind: 'waiting'; readonly round: HeldRound };

/** One native module and the tool round it may hold open. */
export type Provider = { readonly bridge: NativeModelBridge; loop: ToolLoop };

/**
 * Every provider this app built, so a release by owner can reach the bridge
 * holding that owner's round. The slot is per module, and a caller that ends an
 * exchange cannot name the native module, so the bridges are kept here.
 */
const providers = new Set<Provider>();

/** A provider for one native module, with its tool slot free. */
export function openProvider(bridge: NativeModelBridge): Provider {
  const provider: Provider = { bridge, loop: { kind: 'free' } };
  providers.add(provider);
  return provider;
}

/** Cancels one native generation, whether or not it is still there. */
export async function cancelNative(bridge: NativeModelBridge, id: string): Promise<void> {
  try {
    await bridge.cancel(id);
  } catch {
    // The native request already ended; there is nothing left to stop.
  }
}

/**
 * Ends the round `owner` left waiting between two tool rounds.
 *
 * Stop, a closed chat, a deleted chat and a sign-out all end an exchange while
 * its tools run, and that round can never be answered: left alone it holds the
 * on-device model busy for every later ask. Only that owner's generation is
 * cancelled and cleared; another chat's round, and a normal handoff between
 * rounds of the same exchange, are untouched.
 */
export async function releaseNativeModelRound(owner: string): Promise<void> {
  const waiting = [...providers].flatMap(provider => {
    const round = provider.loop.kind === 'waiting' ? provider.loop.round : undefined;
    return round?.owner === owner ? [{ provider, round }] : [];
  });
  await Promise.all(
    waiting.map(async ({ provider, round }) => {
      provider.loop = { kind: 'free' };
      await cancelNative(provider.bridge, round.id);
    })
  );
}
