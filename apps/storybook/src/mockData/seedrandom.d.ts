declare module 'seedrandom' {
  type PRNG = () => number;

  interface SeedRandomOptions {
    entropy?: boolean;
    state?: boolean;
    pass?: PRNG;
    global?: boolean;
  }

  function seedrandom(seed?: string | number, options?: SeedRandomOptions): PRNG;

  export = seedrandom;
}
