CREATE TABLE "invite_use" (
	"id" text PRIMARY KEY NOT NULL,
	"invite_id" text NOT NULL,
	"email" text NOT NULL,
	"user_id" text,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_use" ADD CONSTRAINT "invite_use_invite_id_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_use_invite_idx" ON "invite_use" USING btree ("invite_id","used_at");