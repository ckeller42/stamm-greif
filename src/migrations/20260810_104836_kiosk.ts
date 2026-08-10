import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "kiosk_sessions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"revoked_at" timestamp(3) with time zone,
  	"created_by_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "photos" ADD COLUMN "kiosk_freigegeben" boolean DEFAULT false;
  ALTER TABLE "_photos_v" ADD COLUMN "version_kiosk_freigegeben" boolean DEFAULT false;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "kiosk_sessions_id" integer;
  ALTER TABLE "kiosk_sessions" ADD CONSTRAINT "kiosk_sessions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "kiosk_sessions_created_by_idx" ON "kiosk_sessions" USING btree ("created_by_id");
  CREATE INDEX "kiosk_sessions_updated_at_idx" ON "kiosk_sessions" USING btree ("updated_at");
  CREATE INDEX "kiosk_sessions_created_at_idx" ON "kiosk_sessions" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_kiosk_sessions_fk" FOREIGN KEY ("kiosk_sessions_id") REFERENCES "public"."kiosk_sessions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_kiosk_sessions_id_idx" ON "payload_locked_documents_rels" USING btree ("kiosk_sessions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "kiosk_sessions" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "kiosk_sessions" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_kiosk_sessions_fk";
  
  DROP INDEX "payload_locked_documents_rels_kiosk_sessions_id_idx";
  ALTER TABLE "photos" DROP COLUMN "kiosk_freigegeben";
  ALTER TABLE "_photos_v" DROP COLUMN "version_kiosk_freigegeben";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "kiosk_sessions_id";`)
}
