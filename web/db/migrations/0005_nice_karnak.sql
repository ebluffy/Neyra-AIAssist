ALTER TABLE "invite" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "used_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "email" text;--> statement-breakpoint
-- Существующие инвайты были одноразовыми: сохраняем это поведение (AR-35).
UPDATE "invite" SET "max_uses" = 1 WHERE "max_uses" IS NULL;--> statement-breakpoint
UPDATE "invite" SET "used_count" = 1 WHERE "used_at" IS NOT NULL AND "used_count" = 0;
