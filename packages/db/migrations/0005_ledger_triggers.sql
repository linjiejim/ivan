-- 只追加（D68）：决策账本、计划快照与计划项不许 UPDATE / DELETE。
-- 以后真要做纠正性迁移，只能在迁移里显式 DROP 这些触发器、改完再按原样 CREATE 回来（并在迁移说明里写清楚改了什么、为什么）。
CREATE TRIGGER IF NOT EXISTS `ledger_entries_no_update` BEFORE UPDATE ON `ledger_entries` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `ledger_entries_no_delete` BEFORE DELETE ON `ledger_entries` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `plan_snapshots_no_update` BEFORE UPDATE ON `plan_snapshots` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `plan_snapshots_no_delete` BEFORE DELETE ON `plan_snapshots` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `plan_items_no_update` BEFORE UPDATE ON `plan_items` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `plan_items_no_delete` BEFORE DELETE ON `plan_items` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
