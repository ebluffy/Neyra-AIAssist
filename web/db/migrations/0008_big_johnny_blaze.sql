ALTER TABLE "user" ADD COLUMN "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "user" SET "onboarding_completed_at" = now() WHERE "onboarding_completed_at" IS NULL;