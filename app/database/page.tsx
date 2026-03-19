import { db } from "@/lib/db";
import { bookings, vans } from "@/drizzle/schema";
import { eq } from "drizzle-orm";
import Link from "next/link";

export const dynamic = "force-dynamic";

const COLS = [
  "id", "travel_date", "from_location", "to_location",
  "is_round_trip", "details", "van_id", "van_number", "manual_change",
];

export default async function DatabasePage() {
  let rows: Record<string, unknown>[] = [];
  let fetchError: string | null = null;

  try {
    const data = await db
      .select({
        id: bookings.id,
        travelDate: bookings.travelDate,
        fromLocation: bookings.fromLocation,
        toLocation: bookings.toLocation,
        isRoundTrip: bookings.isRoundTrip,
        details: bookings.details,
        vanId: bookings.vanId,
        vanNumber: vans.vanNumber,
        manualChange: bookings.manualChange,
      })
      .from(bookings)
      .leftJoin(vans, eq(bookings.vanId, vans.id))
      .orderBy(bookings.id);

    rows = data.map((r) => ({
      id: r.id,
      travel_date: r.travelDate,
      from_location: r.fromLocation,
      to_location: r.toLocation,
      is_round_trip: r.isRoundTrip,
      details: r.details,
      van_id: r.vanId,
      van_number: r.vanNumber,
      manual_change: r.manualChange,
    }));
  } catch (e) {
    fetchError = String(e);
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans">
      <header className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Raw Database</h1>
          <p className="text-sm text-zinc-500">{rows.length} row{rows.length !== 1 ? "s" : ""} in bookings</p>
        </div>
        <nav className="flex gap-4 text-sm font-medium">
          <Link href="/" className="text-zinc-500 hover:text-zinc-900 transition-colors">
            Dashboard
          </Link>
          <span className="text-zinc-900 border-b-2 border-zinc-900 pb-0.5">Raw Database</span>
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {fetchError ? (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            {fetchError}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-20 text-zinc-400">
            No rows in database.{" "}
            <Link href="/" className="underline hover:text-zinc-600">
              Upload a PDF
            </Link>{" "}
            to get started.
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-zinc-200 overflow-auto shadow-sm">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="bg-zinc-50 border-b border-zinc-200">
                  {COLS.map((col) => (
                    <th
                      key={col}
                      className="px-3 py-2.5 text-left font-semibold text-zinc-600 whitespace-nowrap"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {rows.map((row) => (
                  <tr key={String(row.id)} className="hover:bg-zinc-50">
                    {COLS.map((col) => {
                      const val = row[col];
                      return (
                        <td
                          key={col}
                          className="px-3 py-2 whitespace-nowrap max-w-[200px] truncate text-zinc-700"
                          title={val == null ? "NULL" : String(val)}
                        >
                          {val == null ? (
                            <span className="text-zinc-400">NULL</span>
                          ) : (
                            String(val)
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
