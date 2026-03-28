import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

const vans = [
  { vanNumber: "VKE 8518", driverName: "Chang Zi-Kang (Jordan)", driverContact: "", singaporeEnabled: 1, thailandEnabled: 0 },
  { vanNumber: "VKB 8468", driverName: "Lee Yoke Khuan (Tiger)",  driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
  { vanNumber: "VKB 8158", driverName: "Wong Chee Khen (Kenji)",  driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
  { vanNumber: "VKB 8518", driverName: "Wong Kim Long (Mark)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VPK 8138", driverName: "Wong Pak Woon (Ivan)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 0 },
  { vanNumber: "VNK 8348", driverName: "Look Swee Yit (Luke)",    driverContact: "", singaporeEnabled: 0, thailandEnabled: 1 },
];

async function main() {
  for (const v of vans) {
    const existing = await db.select().from(schema.vans).where(eq(schema.vans.vanNumber, v.vanNumber)).limit(1);
    if (existing.length === 0) {
      await db.insert(schema.vans).values(v);
      console.log("Created:", v.vanNumber, "-", v.driverName);
    } else {
      await db.update(schema.vans)
        .set({ driverName: v.driverName, driverContact: v.driverContact, singaporeEnabled: v.singaporeEnabled, thailandEnabled: v.thailandEnabled })
        .where(eq(schema.vans.vanNumber, v.vanNumber));
      console.log("Updated:", v.vanNumber, `SG=${v.singaporeEnabled} TH=${v.thailandEnabled}`);
    }
  }
  console.log("Done.");
}

main().catch(console.error);
