import * as migration_20260803_203111_initial_schema from './20260803_203111_initial_schema';
import * as migration_20260809_093215_exif_fields from './20260809_093215_exif_fields';

export const migrations = [
  {
    up: migration_20260803_203111_initial_schema.up,
    down: migration_20260803_203111_initial_schema.down,
    name: '20260803_203111_initial_schema',
  },
  {
    up: migration_20260809_093215_exif_fields.up,
    down: migration_20260809_093215_exif_fields.down,
    name: '20260809_093215_exif_fields'
  },
];
