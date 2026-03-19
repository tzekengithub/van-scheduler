import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";

export async function POST() {
  try {
    await db.delete(bookings);
    return NextResponse.json({ message: "All bookings cleared" });
  } catch (error) {
    console.error("POST /api/clear error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
