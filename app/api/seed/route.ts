import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

const DEFAULT_VANS = [
  { vanNumber: "VKE 8518", driverName: "Chang Zi-Kang (Jordan)", driverContact: "", singaporeEnabled: 1, thailandEnabled: 0 },
  { vanNumber: "VKB 8468", driverName: "Lee Yoke Khuan (Tiger)",  driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
  { vanNumber: "VKB 8158", driverName: "Wong Chee Khen (Kenji)",  driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
  { vanNumber: "VKB 8518", driverName: "Wong Kim Long (Mark)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VPK 8138", driverName: "Wong Pak Woon (Ivan)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VNK 8348", driverName: "Look Swee Yit (Luke)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
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
