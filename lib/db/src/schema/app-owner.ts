import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const appOwnerTable = pgTable("app_owner", {
  id: integer("id").primaryKey(),
  userId: text("user_id").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppOwner = typeof appOwnerTable.$inferSelect;
