import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

type BackendStoreKiloPassProductOutput =
  RouterOutputs['kiloPass']['getMobileStoreProducts']['products'][number];

export type BackendStoreKiloPassProduct = Omit<
  BackendStoreKiloPassProductOutput,
  'tier' | 'cadence'
> & {
  tier: `${BackendStoreKiloPassProductOutput['tier']}`;
  cadence: `${BackendStoreKiloPassProductOutput['cadence']}`;
};

export type StoreKiloPassProduct = {
  id: string;
  displayPrice: string;
  title: string;
  description: string;
  /** Google Play offer token for the selected base plan; absent on iOS. */
  offerToken?: string;
};

export type AppStoreKiloPassProduct = BackendStoreKiloPassProduct & {
  appAccountToken: string;
  displayPrice: string;
  title: string;
  description: string;
  storeProduct: StoreKiloPassProduct;
};

export function joinAppStoreKiloPassProducts(params: {
  appAccountToken: string;
  backendProducts: readonly BackendStoreKiloPassProduct[];
  storeProducts: readonly StoreKiloPassProduct[];
  /** Which storefront the SKUs came from; the join key differs per store. */
  storefront: 'app_store' | 'play';
}): AppStoreKiloPassProduct[] {
  const storeById = new Map(params.storeProducts.map(product => [product.id, product]));
  const joinKey = params.storefront === 'play' ? 'googleProductId' : 'appleProductId';

  return params.backendProducts.flatMap(backendProduct => {
    const storeProduct = storeById.get(backendProduct[joinKey]);
    if (!storeProduct) {
      return [];
    }

    return [
      {
        ...backendProduct,
        appAccountToken: params.appAccountToken,
        displayPrice: storeProduct.displayPrice,
        title: storeProduct.title,
        description: storeProduct.description,
        storeProduct,
      },
    ];
  });
}
