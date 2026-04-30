import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";

const REQUIRED_CONFIRM = "CLEAR BOOKINGS";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { confirm?: string };
    if (body.confirm !== REQUIRED_CONFIRM) {
      return NextResponse.json({ error: "Missing confirmation" }, { status: 400 });
    }
    await db.delete(bookings);
    return NextResponse.json({ message: "All bookings cleared" });
  } catch (error) {
    console.error("POST /api/clear error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
