type KiloPassCompletionRouter = {
  dismiss: () => void;
};

export function dismissKiloPassAfterPurchase(router: KiloPassCompletionRouter) {
  router.dismiss();
}
