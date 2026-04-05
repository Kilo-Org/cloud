declare module 'augment/next' {
  global {
    export type NextAppSearchParams = {
      [key: string]: string | string[] | undefined;
    };
    export type NextAppSearchParamsPromise = Promise<NextAppSearchParams>;
    export type AppPageProps<T extends { [key: string]: string } = undefined> = {
      params: Promise<T>;
      searchParams: NextAppSearchParamsPromise;
    };
  }
}
