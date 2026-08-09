import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "photos" ADD COLUMN "phash" varchar;
  ALTER TABLE "photos" ADD COLUMN "duplicate_of_id" integer;
  ALTER TABLE "photos" ADD COLUMN "duplicate_suspected" boolean DEFAULT false;
  ALTER TABLE "_photos_v" ADD COLUMN "version_phash" varchar;
  ALTER TABLE "_photos_v" ADD COLUMN "version_duplicate_of_id" integer;
  ALTER TABLE "_photos_v" ADD COLUMN "version_duplicate_suspected" boolean DEFAULT false;
  ALTER TABLE "photos" ADD CONSTRAINT "photos_duplicate_of_id_photos_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."photos"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_photos_v" ADD CONSTRAINT "_photos_v_version_duplicate_of_id_photos_id_fk" FOREIGN KEY ("version_duplicate_of_id") REFERENCES "public"."photos"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "photos_duplicate_of_idx" ON "photos" USING btree ("duplicate_of_id");
  CREATE INDEX "_photos_v_version_version_duplicate_of_idx" ON "_photos_v" USING btree ("version_duplicate_of_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "photos" DROP CONSTRAINT "photos_duplicate_of_id_photos_id_fk";
  
  ALTER TABLE "_photos_v" DROP CONSTRAINT "_photos_v_version_duplicate_of_id_photos_id_fk";
  
  DROP INDEX "photos_duplicate_of_idx";
  DROP INDEX "_photos_v_version_version_duplicate_of_idx";
  ALTER TABLE "photos" DROP COLUMN "phash";
  ALTER TABLE "photos" DROP COLUMN "duplicate_of_id";
  ALTER TABLE "photos" DROP COLUMN "duplicate_suspected";
  ALTER TABLE "_photos_v" DROP COLUMN "version_phash";
  ALTER TABLE "_photos_v" DROP COLUMN "version_duplicate_of_id";
  ALTER TABLE "_photos_v" DROP COLUMN "version_duplicate_suspected";`)
}
