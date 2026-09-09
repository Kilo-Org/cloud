import journal from './meta/_journal.json';
import m0000 from './0000_vercel_snapshot_build.sql';
import m0001 from './0001_stormy_shriek.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
