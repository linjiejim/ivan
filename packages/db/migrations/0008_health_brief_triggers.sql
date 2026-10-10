-- 只追加（D70）：健康度读数与简报版次不许 UPDATE / DELETE，和 0005 的账本、计划快照同一做法。
-- 以后真要做纠正性迁移，只能在迁移里显式 DROP 这些触发器、改完再按原样 CREATE 回来（并在迁移说明里写清楚改了什么、为什么）。
CREATE TRIGGER IF NOT EXISTS `tracking_health_no_update` BEFORE UPDATE ON `tracking_health` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `tracking_health_no_delete` BEFORE DELETE ON `tracking_health` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `brief_editions_no_update` BEFORE UPDATE ON `brief_editions` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `brief_editions_no_delete` BEFORE DELETE ON `brief_editions` BEGIN SELECT RAISE(ABORT, 'append-only'); END;
