CREATE TABLE `epochs` (
	`epoch` integer PRIMARY KEY NOT NULL,
	`holder_count` integer DEFAULT 0 NOT NULL,
	`indexed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holders` (
	`ata` text NOT NULL,
	`block_time` integer,
	`epoch` integer NOT NULL,
	`holder` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mint` text NOT NULL,
	`signature` text NOT NULL,
	`slot` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holders_mint_unique` ON `holders` (`mint`);--> statement-breakpoint
CREATE UNIQUE INDEX `holders_signature_unique` ON `holders` (`signature`);--> statement-breakpoint
CREATE INDEX `idx_holders_holder` ON `holders` (`holder`);--> statement-breakpoint
CREATE INDEX `idx_holders_epoch` ON `holders` (`epoch`);