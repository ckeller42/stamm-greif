import * as migration_20260803_203111_initial_schema from './20260803_203111_initial_schema';

export const migrations = [
  {
    up: migration_20260803_203111_initial_schema.up,
    down: migration_20260803_203111_initial_schema.down,
    name: '20260803_203111_initial_schema'
  },
];
