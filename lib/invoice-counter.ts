import { db } from "@/lib/db";
import { bookings } from "@/drizzle/schema";
import { like, desc } from "drizzle-orm";

export async function getNextInvoiceNumbers(): Promise<{ invoiceNo: string; bookingNo: string }> {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yearMonth = `${yyyy}${mm}`;
  const prefix = `INV${yearMonth}`;

  // Find highest existing invoice number for this month across all bookings
  const [latest] = await db
    .select({ invoiceNo: bookings.invoiceNo })
    .from(bookings)
    .where(like(bookings.invoiceNo, `${prefix}%`))
    .orderBy(desc(bookings.invoiceNo))
    .limit(1);

  let nextSeq = 1;
  if (latest?.invoiceNo) {
    const existingSeq = parseInt(latest.invoiceNo.slice(prefix.length), 10);
    if (!isNaN(existingSeq)) nextSeq = existingSeq + 1;
  }

  const seq = String(nextSeq).padStart(4, "0");
  return {
    invoiceNo: `${prefix}${seq}`,
    bookingNo: `BOOK${yearMonth}${seq}`,
  };
}
