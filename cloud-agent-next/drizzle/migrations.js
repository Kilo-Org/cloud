import journal from './meta/_journal.json';
import m0000 from './0000_high_mimic.sql';
import m0001 from './0001_add_entity_id.sql';

export default {
  journal,
  migrations: {
    m0000,
    m0001,
  },
};
