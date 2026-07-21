CREATE TABLE "email_signups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"session_id" uuid,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_signups" ADD CONSTRAINT "email_signups_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_signups_email_idx" ON "email_signups" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_signups_source_created_at_idx" ON "email_signups" USING btree ("source","created_at");