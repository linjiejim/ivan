ALTER TABLE `runs` ADD `card` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `card_hash` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `input_hash` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `verify` text;--> statement-breakpoint
CREATE INDEX `runs_card_hash` ON `runs` (`card_hash`);--> statement-breakpoint
ALTER TABLE `trackings` ADD `exec_config` text DEFAULT '{"v":1}' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_daily` ADD `analyses` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_quotas` ADD `analyses` integer;