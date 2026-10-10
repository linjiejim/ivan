CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`as_of` text,
	`payload_table` text NOT NULL,
	`payload_id` text,
	`payload_z` blob,
	`payload_hash` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_user_seq` ON `ledger_entries` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ledger_subject` ON `ledger_entries` (`subject_type`,`subject_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `plan_items` (
	`snapshot_id` text NOT NULL,
	`seq` integer NOT NULL,
	`code` text NOT NULL,
	`name` text,
	`side` text NOT NULL,
	`reason` text NOT NULL,
	`reason_detail` text,
	`rank` integer,
	`score` real,
	`est_price` real,
	`est_shares` real,
	`est_weight` real,
	`ref_close` real,
	`cur_weight` real,
	`failed_conditions` text,
	`factors` text,
	`term_pct` text,
	PRIMARY KEY(`snapshot_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `plan_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tracking_id` text NOT NULL,
	`user_id` text NOT NULL,
	`decision_date` text NOT NULL,
	`plan_date` text NOT NULL,
	`plan_date_basis` text NOT NULL,
	`edition` integer NOT NULL,
	`cause` text NOT NULL,
	`version_id` text NOT NULL,
	`spec_hash` text NOT NULL,
	`data_version` integer,
	`data_as_of` text,
	`engine_version` text NOT NULL,
	`exec_hash` text NOT NULL,
	`input_hash` text,
	`hash_version` integer NOT NULL,
	`explain_hash` text,
	`explain_version` integer,
	`factor_registry_version` integer,
	`regime` text,
	`exposure_current` real,
	`exposure_next` real,
	`equity` real,
	`cash` real,
	`band` integer,
	`bench_sym` text,
	`bench_close` real,
	`positions_z` blob,
	`candidates_z` blob,
	`content_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_snapshots_edition` ON `plan_snapshots` (`tracking_id`,`decision_date`,`edition`);--> statement-breakpoint
CREATE INDEX `plan_snapshots_user` ON `plan_snapshots` (`user_id`);--> statement-breakpoint
CREATE TABLE `tracking_trades` (
	`tracking_id` text NOT NULL,
	`date` text NOT NULL,
	`seq` integer NOT NULL,
	`code` text NOT NULL,
	`name` text,
	`side` text NOT NULL,
	`kind` text NOT NULL,
	`price` real,
	`shares` real,
	`amount` real,
	`fee` real,
	`reason` text,
	`reject_reason` text,
	PRIMARY KEY(`tracking_id`, `date`, `seq`)
);
--> statement-breakpoint
ALTER TABLE `tracking_orders` ADD `snapshot_id` text;