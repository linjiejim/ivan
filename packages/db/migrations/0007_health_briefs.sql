CREATE TABLE `brief_editions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`edition` integer NOT NULL,
	`facts` text NOT NULL,
	`content` text,
	`model` text,
	`grounding` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_editions_edition` ON `brief_editions` (`user_id`,`date`,`edition`);--> statement-breakpoint
CREATE TABLE `tracking_health` (
	`tracking_id` text NOT NULL,
	`date` text NOT NULL,
	`signal` text NOT NULL,
	`state` text NOT NULL,
	`per_metric` text NOT NULL,
	`inputs` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`tracking_id`, `date`)
);
