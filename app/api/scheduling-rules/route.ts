import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { schedulingRules } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import { saveRule, deleteRule } from "@/lib/scheduling-rules";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db.select().from(schedulingRules).where(eq(schedulingRules.active, 1));
  return Response.json(rows);
}

export async function POST(req: NextRequest) {
  const { ruleText } = await req.json();
  if (!ruleText?.trim()) return Response.json({ error: "ruleText required" }, { status: 400 });
  await saveRule(ruleText.trim());
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await deleteRule(id);
  return Response.json({ ok: true });
}
