import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function POST() {
  try {
    const defaultVans = ["1", "2", "3", "4"];
    const created: string[] = [];

    for (const vanNumber of defaultVans) {
      const existing = await db
        .select()
        .from(vans)
        .where(eq(vans.vanNumber, vanNumber))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(vans).values({ vanNumber });
        created.push(vanNumber);
      }
    }

    return NextResponse.json({
      message: created.length > 0
        ? `Created vans: ${created.join(", ")}`
        : "All 4 vans already exist",
    });
  } catch (error) {
    console.error("POST /api/seed error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
