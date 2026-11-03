CREATE TABLE `trial_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`message` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`invite_code` text,
	`notify_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`handled_at` integer
);
--> statement-breakpoint
CREATE INDEX `trial_requests_status` ON `trial_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `trial_requests_email` ON `trial_requests` (`email`);