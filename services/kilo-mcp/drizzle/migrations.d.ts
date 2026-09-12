declare const migrations: {
  journal: {
    entries: Array<{
      idx: number;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>;
  };
  migrations: Record<string, string>;
};
export default migrations;
