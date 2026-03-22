import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";

/**
 * Full van schedule recheck.
 *
 * Resets ALL auto-managed bookings (manualChange = 0) and reassigns vans from
 * scratch using the current DB state. Run this after any mutation that could
 * affect van availability (upload, delete).
 *
 * User-confirmed outsourced bookings (inHouseOrOutsourced = 'O' with a company
 * name filled in) are treated as a manual decision and are never reset.
 *
 * After reassignment, any booking that still could not get a van is marked as
 * inHouseOrOutsourced = 'O' with no company name — this creates a visible
 * conflict in the UI ("OUTSOURCE COMPANY NEEDED") until the user fills in
 * the outsourced company name.
 */
export async function recheckAllVans(): Promise<void> {
  // ── Step 1: Find all auto-managed bookings ───────────────────────────────────
  const allAuto = await db
    .select({
      id: bookings.id,
      inHouseOrOutsourced: bookings.inHouseOrOutsourced,
      outsourcedCompany: bookings.outsourcedCompany,
    })
    .from(bookings)
    .where(eq(bookings.manualChange, 0));

  if (allAuto.length === 0) return;

  // User-confirmed outsourced = I/O is 'O' AND company name is filled in.
  // These are a deliberate user choice — leave them alone.
  const toResetIds = allAuto
    .filter((b) => {
      const userConfirmed =
        b.inHouseOrOutsourced === "O" &&
        (b.outsourcedCompany ?? "").trim() !== "";
      return !userConfirmed;
    })
    .map((b) => b.id);

  if (toResetIds.length === 0) return;

  // ── Step 2: Batch-reset — clear van + restore to in-house ───────────────────
  await db
    .update(bookings)
    .set({
      vanId: null,
      vehiclePlate: null,
      driverName: null,
      driverContact: null,
      inHouseOrOutsourced: "I",
    })
    .where(inArray(bookings.id, toResetIds));

  // ── Step 3: Reassign all cleared bookings ────────────────────────────────────
  // runReassign() with no args picks up all vanId=null, manualChange=0 rows.
  await runReassign();

  // ── Step 4: Any still-unassigned → mark as outsourced ───────────────────────
  // This creates the "OUTSOURCE COMPANY NEEDED" conflict in the UI.
  const stillUnassigned = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        isNull(bookings.vanId),
        eq(bookings.manualChange, 0),
        eq(bookings.inHouseOrOutsourced, "I"),
      )
    );

  if (stillUnassigned.length > 0) {
    await db
      .update(bookings)
      .set({ inHouseOrOutsourced: "O" })
      .where(inArray(bookings.id, stillUnassigned.map((b) => b.id)));
  }
}
