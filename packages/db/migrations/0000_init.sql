CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`facts` text NOT NULL,
	`content` text,
	`model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `briefs_user_date` ON `briefs` (`user_id`,`date`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`strategy_id` text,
	`base_version_id` text,
	`payload` text NOT NULL,
	`summary` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`thread_id` text,
	`result_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `drafts_user` ON `drafts` (`user_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`used_by` text,
	`used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code` ON `invites` (`code`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`note` text,
	`result` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_user` ON `jobs` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`usage` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_thread` ON `messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_trades` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`date` text NOT NULL,
	`code` text NOT NULL,
	`side` text NOT NULL,
	`price` real NOT NULL,
	`shares` real NOT NULL,
	`amount` real NOT NULL,
	`fee` real NOT NULL,
	`reason` text NOT NULL,
	`pnl` real,
	`hold_days` integer,
	PRIMARY KEY(`run_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `run_trades_code` ON `run_trades` (`run_id`,`code`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`version_id` text NOT NULL,
	`kind` text DEFAULT 'backtest' NOT NULL,
	`parent_id` text,
	`label` text,
	`params` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`data_version` integer,
	`data_as_of` text,
	`engine_version` text,
	`metrics` text,
	`segments` text,
	`checks` text,
	`attribution` text,
	`final` text,
	`series_z` blob,
	`holdings_z` blob,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `runs_user` ON `runs` (`user_id`);--> statement-breakpoint
CREATE INDEX `runs_strategy` ON `runs` (`strategy_id`);--> statement-breakpoint
CREATE TABLE `signal_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`rows` text NOT NULL,
	`count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`current_version_id` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `strategies_user` ON `strategies` (`user_id`);--> statement-breakpoint
CREATE TABLE `strategy_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`n` integer NOT NULL,
	`spec` text NOT NULL,
	`spec_hash` text NOT NULL,
	`note` text,
	`source` text DEFAULT 'form' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_strategy_n` ON `strategy_versions` (`strategy_id`,`n`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`context` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_user` ON `threads` (`user_id`);--> statement-breakpoint
CREATE TABLE `tracking_days` (
	`tracking_id` text NOT NULL,
	`date` text NOT NULL,
	`nav` real NOT NULL,
	`bench` real NOT NULL,
	`cash` real NOT NULL,
	`positions` integer NOT NULL,
	PRIMARY KEY(`tracking_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `tracking_orders` (
	`tracking_id` text NOT NULL,
	`plan_date` text NOT NULL,
	`code` text NOT NULL,
	`name` text,
	`side` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tracking_orders_t` ON `tracking_orders` (`tracking_id`);--> statement-breakpoint
CREATE TABLE `trackings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`strategy_id` text NOT NULL,
	`version_id` text NOT NULL,
	`market` text NOT NULL,
	`start_date` text NOT NULL,
	`capital` real NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`baseline_run_id` text,
	`last_date` text,
	`last_nav` real,
	`last_bench` real,
	`deviation_pct` real,
	`summary` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`stopped_at` integer
);
--> statement-breakpoint
CREATE INDEX `trackings_user` ON `trackings` (`user_id`);--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`chat_messages` integer DEFAULT 0 NOT NULL,
	`backtests` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `user_quotas` (
	`user_id` text PRIMARY KEY NOT NULL,
	`chat_messages` integer,
	`backtests` integer
);
