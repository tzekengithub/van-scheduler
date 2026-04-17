import { NextRequest, NextResponse } from "next/server";
import { buildInvoiceHtml, type InvoiceData } from "@/lib/invoice-template";
import { getNextInvoiceNumbers } from "@/lib/invoice-counter";

const HTML2PDF_API_KEY = process.env.HTML2PDF_API_KEY;

interface RawItem {
  route: string;
  travelDate: string;
  vehicleCount: number | string;
  unitPrice: number | string;
  isOneWay?: boolean;
  isAlphard?: boolean;
  is15Pax?: boolean;
  isCar?: boolean;
}

/** Build the Booking Details description string the parser expects.
 *  Route on line 1; each annotation tag on its own subsequent line.
 *  PyMuPDF extracts each <div> as a separate text block → parser picks up annotations. */
function buildDescription(item: RawItem): string {
  const lines: string[] = [item.route.trim()];
  if (item.isOneWay)  lines.push("(One-Way Ride Only)");
  if (item.isAlphard) lines.push("(Alphard)");
  if (item.is15Pax)   lines.push("(15 Pax)");
  if (item.isCar)     lines.push("(5-Seater Car)");
  return lines.join("\n");
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Recalculate amounts server-side — never trust client totals
  const items = (body.items ?? []).map((item: RawItem) => {
    const vehicleCount = parseInt(String(item.vehicleCount), 10) || 1;
    const unitPrice = parseFloat(String(item.unitPrice)) || 0;
    return {
      description: buildDescription(item),
      travelDate: item.travelDate || "",
      vehicleCount,
      unitPrice,
      amount: vehicleCount * unitPrice,
    };
  });

  const total = items.reduce((sum: number, it: { amount: number }) => sum + it.amount, 0);

  const { invoiceNo, bookingNo } = await getNextInvoiceNumbers();

  const invoice: InvoiceData = {
    invoiceNumber: invoiceNo,
    bookingNumber: bookingNo,
    invoiceDate: body.invoiceDate || new Date().toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" }),
    customerName: body.customerName || "",
    contactPerson: body.contactPerson || "",
    customerDetails: body.customerDetails || "",
    items,
    notes: body.notes || "",
    total,
  };

  const html = buildInvoiceHtml(invoice);

  const pdfResp = await fetch("https://api.html2pdf.app/v1/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      apiKey: HTML2PDF_API_KEY,
      format: "A4",
      landscape: false,
      margin_top: "0",
      margin_bottom: "0",
      margin_left: "0",
      margin_right: "0",
    }),
  });

  if (!pdfResp.ok) {
    const err = await pdfResp.text();
    return NextResponse.json({ error: `PDF generation failed: ${err}` }, { status: 502 });
  }

  const pdfBuffer = await pdfResp.arrayBuffer();
  const pdfBase64 = Buffer.from(pdfBuffer).toString("base64");

  return NextResponse.json({ pdfBase64, invoiceNo, bookingNo, total });
}
