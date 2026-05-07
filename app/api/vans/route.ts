import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans, bookings } from "@/drizzle/schema";
import { eq, isNull, and } from "drizzle-orm";
import { runReassign } from "@/lib/reassign";
import { z } from "zod";

const VanPostSchema = z.object({
  vanNumber: z.string().min(1).max(20),
  driverName: z.string().max(100).optional(),
  driverContact: z.string().max(50).optional(),
  singaporeEnabled: z.boolean().optional(),
  thailandEnabled: z.boolean().optional(),
  maxPaxCapacity: z.number().int().min(1).max(50).optional(),
  location: z.string().max(100).optional(),
  vehicleType: z.string().max(50).optional(),
});

const VanPatchSchema = z.object({
  id: z.number().int().positive(),
  singaporeEnabled: z.union([z.literal(0), z.literal(1)]).optional(),
  thailandEnabled: z.union([z.literal(0), z.literal(1)]).optional(),
  maxPaxCapacity: z.number().int().min(1).max(50).optional(),
  location: z.string().max(100).optional(),
  vehicleType: z.string().max(50).optional(),
});

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
    const body = await request.json();
    const parsed = VanPatchSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const { id, singaporeEnabled, thailandEnabled, maxPaxCapacity, location, vehicleType } = parsed.data;

    const updates: Record<string, unknown> = {};
    if (singaporeEnabled !== undefined) updates.singaporeEnabled = singaporeEnabled;
    if (thailandEnabled !== undefined) updates.thailandEnabled = thailandEnabled;
    if (maxPaxCapacity !== undefined) updates.maxPaxCapacity = maxPaxCapacity;
    if (location !== undefined) updates.location = location;
    if (vehicleType !== undefined) updates.vehicleType = vehicleType;

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
    const body = await request.json();
    const parsed = VanPostSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, { status: 400 });
    const { vanNumber, driverName, driverContact, singaporeEnabled, thailandEnabled, maxPaxCapacity, location, vehicleType } = parsed.data;

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
        vehicleType: vehicleType?.trim() ?? "van",
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
