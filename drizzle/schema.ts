import { pgTable, serial, text, integer, numeric } from "drizzle-orm/pg-core";

export const vans = pgTable("vans", {
  id: serial("id").primaryKey(),
  vanNumber: text("van_number").notNull().unique(),
  driverName: text("driver_name").default(""),
  driverContact: text("driver_contact").default(""),
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
  // Invoice fields
  invoiceNo: text("invoice_no").default(""),
  clientDetails: text("client_details").default(""),
  day: text("day").default(""),
  month: text("month").default(""),
  year: text("year").default(""),
  passengerCount: integer("passenger_count").default(0),
  myrPerVehicle: numeric("myr_per_vehicle").default("0"),
  amount: numeric("amount").default("0"),
  // Driver / vehicle (per-booking overrides, copied from van on upload)
  vehiclePlate: text("vehicle_plate").default(""),
  driverName: text("driver_name").default(""),
  driverContact: text("driver_contact").default(""),
  // Status / operational fields
  paidStatus: text("paid_status").default("U"),
  overtime: text("overtime").default(""),
  introducer: text("introducer").default(""),
  inHouseOrOutsourced: text("in_house_or_outsourced").default("I"),
  outsourcedCompany: text("outsourced_company").default(""),
  // New fields — Section 1
  tripType: text("trip_type").default("trip"),
  tourGuide: text("tour_guide"),
  vehicleIndex: integer("vehicle_index").default(1),
  numberOfVehicles: integer("number_of_vehicles").default(1),
});

export type Van = typeof vans.$inferSelect;
export type NewVan = typeof vans.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
