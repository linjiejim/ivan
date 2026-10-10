ALTER TABLE `jobs` ADD `not_before` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `attempt` integer DEFAULT 0 NOT NULL;