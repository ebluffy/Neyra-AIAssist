CREATE TABLE "admin_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "admin_audit_created_at_idx" ON "admin_audit" USING btree ("created_at");