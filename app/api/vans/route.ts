import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  try {
    const rows = await db.select().from(vans).orderBy(vans.id);
    return NextResponse.json(rows);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { vanNumber, driverName, driverContact } = await request.json();
    if (!vanNumber || !vanNumber.trim()) {
      return NextResponse.json({ error: "Plate number is required" }, { status: 400 });
    }

    const plate = vanNumber.trim().toUpperCase();

    const existing = await db.select().from(vans).where(eq(vans.vanNumber, plate)).limit(1);
    if (existing.length > 0) {
      return NextResponse.json({ error: "Plate number already exists" }, { status: 409 });
    }

    const [created] = await db
      .insert(vans)
      .values({
        vanNumber: plate,
        driverName: driverName?.trim() ?? "",
        driverContact: driverContact?.trim() ?? "",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await db.delete(vans).where(eq(vans.id, id));
    return NextResponse.json({ message: "Van deleted" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
