import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const vans = [
  { vanNumber: "VAN-001", driverName: "Driver 1", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0, maxPaxCapacity: 14, location: "KL" },
  { vanNumber: "VAN-002", driverName: "Driver 2", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0, maxPaxCapacity: 14, location: "KL" },
  { vanNumber: "VAN-003", driverName: "Driver 3", driverContact: "", singaporeEnabled: 0, thailandEnabled: 0, maxPaxCapacity: 14, location: "KL" },
];

async function main() {
  for (const v of vans) {
    const existing = await db.select().from(schema.vans).where(eq(schema.vans.vanNumber, v.vanNumber)).limit(1);
    if (existing.length === 0) {
      await db.insert(schema.vans).values(v);
      console.log("Created:", v.vanNumber, "-", v.driverName);
    } else {
      await db.update(schema.vans)
        .set({ driverName: v.driverName, driverContact: v.driverContact, singaporeEnabled: v.singaporeEnabled, thailandEnabled: v.thailandEnabled, maxPaxCapacity: v.maxPaxCapacity, location: v.location })
        .where(eq(schema.vans.vanNumber, v.vanNumber));
      console.log("Updated:", v.vanNumber, `SG=${v.singaporeEnabled} TH=${v.thailandEnabled}`);
    }
  }
  console.log("Done.");
}

main().catch(console.error);
