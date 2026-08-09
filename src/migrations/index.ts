import * as migration_20260803_203111_initial_schema from './20260803_203111_initial_schema';
import * as migration_20260809_093215_exif_fields from './20260809_093215_exif_fields';
import * as migration_20260809_110711_phash_fields from './20260809_110711_phash_fields';
import * as migration_20260809_175517_face_suggestions from './20260809_175517_face_suggestions';
import * as migration_20260809_182337_detect_faces_task from './20260809_182337_detect_faces_task';

export const migrations = [
  {
    up: migration_20260803_203111_initial_schema.up,
    down: migration_20260803_203111_initial_schema.down,
    name: '20260803_203111_initial_schema',
  },
  {
    up: migration_20260809_093215_exif_fields.up,
    down: migration_20260809_093215_exif_fields.down,
    name: '20260809_093215_exif_fields',
  },
  {
    up: migration_20260809_110711_phash_fields.up,
    down: migration_20260809_110711_phash_fields.down,
    name: '20260809_110711_phash_fields',
  },
  {
    up: migration_20260809_175517_face_suggestions.up,
    down: migration_20260809_175517_face_suggestions.down,
    name: '20260809_175517_face_suggestions',
  },
  {
    up: migration_20260809_182337_detect_faces_task.up,
    down: migration_20260809_182337_detect_faces_task.down,
    name: '20260809_182337_detect_faces_task'
  },
];
