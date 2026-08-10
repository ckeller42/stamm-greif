import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_face_suggestions_status" AS ENUM('offen', 'bestaetigt', 'abgelehnt');
  CREATE TABLE "face_suggestions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"photo_id" integer NOT NULL,
  	"box_x_min" numeric NOT NULL,
  	"box_y_min" numeric NOT NULL,
  	"box_x_max" numeric NOT NULL,
  	"box_y_max" numeric NOT NULL,
  	"box_probability" numeric,
  	"embedding" jsonb,
  	"suggested_person_id" integer,
  	"similarity" numeric,
  	"status" "enum_face_suggestions_status" DEFAULT 'offen' NOT NULL,
  	"confirmed_by_id" integer,
  	"confirmed_at" timestamp(3) with time zone,
  	"detected_at" timestamp(3) with time zone,
  	"source_variant" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "face_suggestions_id" integer;
  ALTER TABLE "face_suggestions" ADD CONSTRAINT "face_suggestions_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "face_suggestions" ADD CONSTRAINT "face_suggestions_suggested_person_id_people_id_fk" FOREIGN KEY ("suggested_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "face_suggestions" ADD CONSTRAINT "face_suggestions_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "face_suggestions_photo_idx" ON "face_suggestions" USING btree ("photo_id");
  CREATE INDEX "face_suggestions_suggested_person_idx" ON "face_suggestions" USING btree ("suggested_person_id");
  CREATE INDEX "face_suggestions_status_idx" ON "face_suggestions" USING btree ("status");
  CREATE INDEX "face_suggestions_confirmed_by_idx" ON "face_suggestions" USING btree ("confirmed_by_id");
  CREATE INDEX "face_suggestions_updated_at_idx" ON "face_suggestions" USING btree ("updated_at");
  CREATE INDEX "face_suggestions_created_at_idx" ON "face_suggestions" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_face_suggestions_fk" FOREIGN KEY ("face_suggestions_id") REFERENCES "public"."face_suggestions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_face_suggestions_id_idx" ON "payload_locked_documents_rels" USING btree ("face_suggestions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "face_suggestions" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "face_suggestions" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_face_suggestions_fk";
  
  DROP INDEX "payload_locked_documents_rels_face_suggestions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "face_suggestions_id";
  DROP TYPE "public"."enum_face_suggestions_status";`)
}
