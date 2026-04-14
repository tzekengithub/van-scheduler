import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

const DEFAULT_VANS = [
  { vanNumber: "VAN-001", driverName: "Driver 1", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VAN-002", driverName: "Driver 2", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VAN-003", driverName: "Driver 3", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
];

export async function POST() {
  try {
    const created: string[] = [];

    for (const van of DEFAULT_VANS) {
      const existing = await db
        .select()
        .from(vans)
        .where(eq(vans.vanNumber, van.vanNumber))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(vans).values(van);
        created.push(van.vanNumber);
      }
    }

    return NextResponse.json({
      message: created.length > 0
        ? `Created vans: ${created.join(", ")}`
        : "All vans already exist",
    });
  } catch (error) {
    console.error("POST /api/seed error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
