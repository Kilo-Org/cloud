import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

type RouterOutputs = inferRouterOutputs<RootRouter>;

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
}): AppStoreKiloPassProduct[] {
  const storeById = new Map(params.storeProducts.map(product => [product.id, product]));

  return params.backendProducts.flatMap(backendProduct => {
    const storeProduct = storeById.get(backendProduct.appleProductId);
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
