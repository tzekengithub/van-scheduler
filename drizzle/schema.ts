import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

export const vans = pgTable("vans", {
  id: serial("id").primaryKey(),
  vanNumber: text("van_number").notNull().unique(),
});

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  travelDate: text("travel_date").notNull(),
  fromLocation: text("from_location").notNull(),
  toLocation: text("to_location").notNull(),
  isRoundTrip: integer("is_round_trip").notNull().default(0),
  details: text("details"),
  vanId: integer("van_id").references(() => vans.id),
  manualChange: integer("manual_change").notNull().default(0),
});

export type Van = typeof vans.$inferSelect;
export type NewVan = typeof vans.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
