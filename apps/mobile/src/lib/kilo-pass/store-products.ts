import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';
import { type ProductSubscription } from 'expo-iap';

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

type MinimalStoreProduct = Pick<
  ProductSubscription,
  'id' | 'displayPrice' | 'title' | 'description'
>;

export type AppStoreKiloPassProduct = BackendStoreKiloPassProduct & {
  displayPrice: string;
  title: string;
  description: string;
  storeProduct: ProductSubscription | MinimalStoreProduct;
};

export function joinAppStoreKiloPassProducts(params: {
  backendProducts: readonly BackendStoreKiloPassProduct[];
  storeProducts: readonly (ProductSubscription | MinimalStoreProduct)[];
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
        displayPrice: storeProduct.displayPrice,
        title: storeProduct.title,
        description: storeProduct.description,
        storeProduct,
      },
    ];
  });
}
