CREATE TYPE "public"."usage_event_status" AS ENUM('success', 'failure');--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "dropped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "status" "usage_event_status" DEFAULT 'success' NOT NULL;