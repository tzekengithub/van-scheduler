import { db } from "@/lib/db";
import { schedulingRules } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export async function getActiveRules(): Promise<string[]> {
  const rows = await db
    .select({ ruleText: schedulingRules.ruleText })
    .from(schedulingRules)
    .where(eq(schedulingRules.active, 1));
  return rows.map((r) => r.ruleText);
}

export async function saveRule(ruleText: string): Promise<void> {
  await db.insert(schedulingRules).values({
    ruleText,
    createdAt: new Date().toISOString(),
    active: 1,
  });
}

export async function deleteRule(id: number): Promise<void> {
  await db.update(schedulingRules).set({ active: 0 }).where(eq(schedulingRules.id, id));
}
