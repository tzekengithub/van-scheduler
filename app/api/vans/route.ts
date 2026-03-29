import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans, bookings } from "@/drizzle/schema";
import { eq, isNull, and } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";

export const runtime = "nodejs";

export async function GET() {
  try {
    const rows = await db.select().from(vans).orderBy(vans.id);
    return NextResponse.json(rows);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, singaporeEnabled, thailandEnabled, maxPaxCapacity, location } = await request.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const updates: Record<string, unknown> = {};
    if (typeof singaporeEnabled === "number") updates.singaporeEnabled = singaporeEnabled;
    if (typeof thailandEnabled === "number") updates.thailandEnabled = thailandEnabled;
    if (typeof maxPaxCapacity === "number") updates.maxPaxCapacity = maxPaxCapacity;
    if (typeof location === "string") updates.location = location;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const [updated] = await db
      .update(vans)
      .set(updates)
      .where(eq(vans.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { vanNumber, driverName, driverContact, singaporeEnabled, thailandEnabled, maxPaxCapacity, location } = await request.json();
    if (!vanNumber || !vanNumber.trim()) {
      return NextResponse.json({ error: "Plate number is required" }, { status: 400 });
    }

    const plate = vanNumber.trim().toUpperCase();

    const existing = await db.select().from(vans).where(eq(vans.vanNumber, plate)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ error: "Plate number already exists" }, { status: 409 });
    }

    // Step 1: Insert the new van
    const [created] = await db
      .insert(vans)
      .values({
        vanNumber: plate,
        driverName: driverName?.trim() ?? "",
        driverContact: driverContact?.trim() ?? "",
        singaporeEnabled: singaporeEnabled ? 1 : 0,
        thailandEnabled: thailandEnabled ? 1 : 0,
        maxPaxCapacity: typeof maxPaxCapacity === "number" ? maxPaxCapacity : 4,
        location: location?.trim() ?? "",
      })
      .returning();

    // Step 2: Try to assign the new van to any currently unassigned bookings
    const { assigned, conflicts } = await runReassign();
    console.log(
      `[vans/POST] new van ${plate} → reassigned ${assigned} previously unassigned bookings (${conflicts} still conflict)`
    );

    return NextResponse.json({ ...created, reassigned: assigned }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Step 1: Null out all bookings that reference this van
    //         Reset manualChange too so they are eligible for auto-reassign
    const affected = await db
      .update(bookings)
      .set({ vanId: null, manualChange: 0, vehiclePlate: "", driverName: "", driverContact: "" })
      .where(eq(bookings.vanId, id))
      .returning({ id: bookings.id });

    const affectedIds = affected.map((r) => r.id);
    console.log(
      `[vans/DELETE] nulled ${affectedIds.length} bookings for vanId=${id}:`,
      affectedIds
    );

    // Step 2: Delete the van
    await db.delete(vans).where(eq(vans.id, id));

    // Step 3: Reassign the affected bookings to remaining vans
    const { assigned, conflicts } = await runReassign(affectedIds);
    console.log(
      `[vans/DELETE] reassigned ${assigned}/${affectedIds.length} (${conflicts} conflict)`
    );

    return NextResponse.json({ message: "Van deleted", reassigned: assigned, conflicts });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
