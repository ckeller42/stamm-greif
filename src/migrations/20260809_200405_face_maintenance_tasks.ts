// P2.3 Task 6: registering backfillFacesTask/reconcileHiddenFaceDataTask in payload.config.ts's
// jobs.tasks adds their slugs to the payload_jobs/payload_jobs_log task-slug enums, same
// mechanical reason the detectFaces task got its own migration in Task 3.
import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'backfillFaces';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'reconcileHiddenFaceData';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'backfillFaces';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'reconcileHiddenFaceData';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'purgePapierkorb', 'detectFaces');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'purgePapierkorb', 'detectFaces');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";`)
}
