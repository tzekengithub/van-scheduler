import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { gte } from "drizzle-orm";
import { asc } from "drizzle-orm";

export async function buildScheduleContext(): Promise<string> {
  const today = new Date().toISOString().split("T")[0];

  const allVans = await db.select().from(vans);
  const futureBookings = await db
    .select()
    .from(bookings)
    .where(gte(bookings.travelDate, today))
    .orderBy(asc(bookings.travelDate));

  const totalBookings = futureBookings.length;
  const unassigned = futureBookings.filter(
    (b) => !b.vanId && b.inHouseOrOutsourced !== "O",
  ).length;
  const outsourced = futureBookings.filter(
    (b) => b.inHouseOrOutsourced === "O",
  ).length;
  const outsourcedNoCompany = futureBookings.filter(
    (b) => b.inHouseOrOutsourced === "O" && !(b.outsourcedCompany ?? "").trim(),
  ).length;

  // Cap to next 60 days if more than 150 bookings
  let displayBookings = futureBookings;
  let truncated = false;
  if (futureBookings.length > 150) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 60);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    displayBookings = futureBookings.filter((b) => b.travelDate <= cutoffStr);
    truncated = true;
  }

  const vanMap = new Map(allVans.map((v) => [v.id, v.vanNumber]));

  const vansSection = allVans
    .map(
      (v) =>
        `- ${v.vanNumber} | ${v.driverName ?? "Unknown"} | SG:${v.singaporeEnabled ? "Yes" : "No"} TH:${v.thailandEnabled ? "Yes" : "No"} | Seats:${v.maxPaxCapacity ?? "?"}`,
    )
    .join("\n");

  const bookingRows = displayBookings
    .map((b) => {
      let vanStatus: string;
      if (b.vanId) {
        vanStatus = vanMap.get(b.vanId) ?? "Unknown";
      } else if (b.inHouseOrOutsourced === "O") {
        vanStatus = b.outsourcedCompany?.trim()
          ? `OUTSOURCED (${b.outsourcedCompany})`
          : "OUTSOURCED (no company!)";
      } else {
        vanStatus = "UNASSIGNED";
      }
      const client = (b.clientDetails ?? "").split("\n")[0] || "-";
      return `${b.travelDate} | ${b.invoiceNo || "-"} | ${client} | ${b.fromLocation}→${b.toLocation} | ${b.tripType ?? "trip"} | ${vanStatus} | ${b.driverName || "-"} | ${b.paidStatus ?? "U"} | ${b.inHouseOrOutsourced === "O" ? "Out" : "In"}`;
    })
    .join("\n");

  const header = truncated
    ? `BOOKINGS (next 60 days only — ${futureBookings.length - displayBookings.length} more beyond 60 days):`
    : `BOOKINGS (${displayBookings.length} upcoming):`;

  return `TODAY: ${today}

FLEET (${allVans.length} vans):
${vansSection || "No vans configured."}

SUMMARY:
- Total upcoming bookings: ${totalBookings}
- Unassigned: ${unassigned}
- Outsourced: ${outsourced}
- Outsourced with NO company name (CONFLICT — needs attention): ${outsourcedNoCompany}

${header}
Date | Invoice | Client | Route | TripType | Van/Status | Driver | Paid | In/Out
${bookingRows || "No upcoming bookings."}`;
}
