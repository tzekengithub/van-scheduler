export interface InvoiceItem {
  description: string;
  travelDate: string;
  vehicleCount: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceData {
  invoiceNumber: string;
  bookingNumber: string;
  invoiceDate: string;
  customerName: string;
  contactPerson: string;
  customerDetails: string;
  items: InvoiceItem[];
  notes: string;
  total: number;
}

function fmt(n: number): string {
  return Number(n).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildInvoiceHtml(inv: InvoiceData): string {
  const itemRows = inv.items
    .map((item, i) => {
      const lines = esc(item.description).split("\n").filter(Boolean);
      const mainLine = lines[0] || "";
      const subLines = lines
        .slice(1)
        .map((l) => `<div style="font-size:7.5pt;margin-top:2px;">${l}</div>`)
        .join("");

      return `<tr>
    <td style="width:22px;vertical-align:top;padding:5px 4px;font-size:8.5pt;">${i + 1}.</td>
    <td style="vertical-align:top;padding:5px 4px;font-size:8.5pt;">
      <div>${mainLine}</div>${subLines}
    </td>
    <td style="width:88px;vertical-align:top;padding:5px 4px;font-size:8.5pt;white-space:nowrap;">${esc(item.travelDate)}</td>
    <td style="width:72px;vertical-align:top;padding:5px 4px;font-size:8.5pt;text-align:center;">${item.vehicleCount}</td>
    <td style="width:78px;vertical-align:top;padding:5px 4px;font-size:8.5pt;text-align:right;">${fmt(item.unitPrice)}</td>
    <td style="width:88px;vertical-align:top;padding:5px 4px;font-size:8.5pt;text-align:right;">${fmt(item.amount)}</td>
  </tr>`;
    })
    .join("");

  let clientLines = `<div style="font-weight:bold;">${esc(inv.customerName)}</div>`;
  if (inv.contactPerson && inv.contactPerson.toLowerCase() !== inv.customerName.toLowerCase()) {
    clientLines += `<div>${esc(inv.contactPerson)}</div>`;
  }
  if (inv.customerDetails) {
    clientLines += `<div>${esc(inv.customerDetails)}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Invoice ${esc(inv.invoiceNumber)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9pt;
    color: #000;
    background: #fff;
    margin: 0;
    padding: 14mm 14mm 12mm 14mm;
  }
  @page { size: A4; margin: 14mm 14mm 12mm 14mm; }
  @media print {
    .page2 { page-break-before: always; }
  }
</style>
</head>
<body>

<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
  <tr>
    <td width="130" valign="top" align="center" rowspan="3" style="padding-right:8px;">
      <div style="width:88px;height:72px;border:1.5px solid #b8860b;
                  font-size:6.5pt;color:#b8860b;text-align:center;
                  line-height:1.4;padding-top:22px;margin:0 auto;">
        ETSM88<br>LOGO
      </div>
      <div style="font-size:5.5pt;font-style:italic;color:#b8860b;font-weight:bold;
                  text-transform:uppercase;line-height:1.3;text-align:center;
                  margin-top:4px;width:110px;">
        EXCELLENT TRAVEL<br>SERVICES AND MANAGEMENT 88 SDN BHD
      </div>
    </td>
    <td valign="bottom" align="center" style="padding-bottom:4px;">
      <div style="font-size:22pt;font-weight:bold;letter-spacing:1px;">INVOICE</div>
    </td>
    <td width="290" valign="top" align="right" style="font-size:8.5pt;line-height:1.6;">
      <div style="font-weight:bold;">Excellent Travel Services and Management 88 Sdn. Bhd.</div>
      <div>202001003105 (1359424-M) (KPK/LN: 10544)</div>
    </td>
  </tr>
  <tr>
    <td valign="top" style="padding-top:6px;">
      <div style="font-weight:bold;font-size:8.5pt;">Invoice Date</div>
      <div style="font-size:9pt;margin:2px 0 8px;">${esc(inv.invoiceDate)}</div>
      <div style="font-weight:bold;font-size:8.5pt;">Invoice Number</div>
      <div style="font-size:9pt;margin-top:2px;">${esc(inv.invoiceNumber)}</div>
    </td>
    <td valign="top" align="right" style="font-size:8.5pt;line-height:1.6;padding-top:6px;">
      <div>1-08-06, Plaza Bukit Jalil (Aurora Sovo), No. 1, Persiaran Jalil 1,</div>
      <div>Bandar Bukit Jalil, 57000 Kuala Lumpur, Malaysia.</div>
    </td>
  </tr>
  <tr>
    <td></td>
    <td valign="bottom" align="right" style="font-size:8.5pt;line-height:1.9;padding-top:6px;">
      <div><span style="font-weight:bold;">Company Email</span> : etsmfinance@gmail.com</div>
      <div><span style="font-weight:bold;">Company Contact No</span> : +60 12-606 1728</div>
    </td>
  </tr>
</table>

<hr style="border:none;border-top:2px solid #000;margin:6px 0;"/>

<table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 8px;">
  <tr>
    <td width="200" valign="top">
      <div style="font-weight:bold;font-size:8.5pt;">Booking Number</div>
      <div style="font-size:9pt;margin-top:2px;">${esc(inv.bookingNumber)}</div>
    </td>
    <td valign="top" align="right" style="font-size:9pt;line-height:1.7;">
      <div style="font-weight:bold;font-size:8.5pt;">Client's Details</div>
      ${clientLines}
    </td>
  </tr>
</table>

<hr style="border:none;border-top:1px solid #000;margin:6px 0;"/>

<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:2px;">
  <thead>
    <tr style="border-bottom:2px solid #000;">
      <th width="22"  style="padding:4px 4px;text-align:left;font-size:8.5pt;border-bottom:2px solid #000;">No</th>
      <th            style="padding:4px 4px;text-align:left;font-size:8.5pt;border-bottom:2px solid #000;">Booking Details</th>
      <th width="88"  style="padding:4px 4px;text-align:left;font-size:8.5pt;border-bottom:2px solid #000;">Travel Date</th>
      <th width="72"  style="padding:4px 4px;text-align:center;font-size:8.5pt;border-bottom:2px solid #000;">Number of Vehicle</th>
      <th width="78"  style="padding:4px 4px;text-align:right;font-size:8.5pt;border-bottom:2px solid #000;">MYR/Vehicle</th>
      <th width="88"  style="padding:4px 4px;text-align:right;font-size:8.5pt;border-bottom:2px solid #000;">Amount (MYR)</th>
    </tr>
  </thead>
  <tbody>
    ${itemRows}
  </tbody>
</table>

<div style="margin:10px 0 6px;font-size:8pt;line-height:1.5;font-weight:bold;">
  COMPANY POLICY:<br>
  Client must pay 50% from total amount within 3 days from invoice date as deposit to reserve company&#39;s vehicle. If payment is
  not made, company&#39;s vehicle will not be reserved and it will be depending on company&#39;s vehicle availability on client&#39;s travel
  date.
</div>

<table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #000;margin-top:4px;">
  <tr>
    <td style="padding-top:6px;">&nbsp;</td>
    <td width="200" align="right" style="padding-top:6px;">
      <table cellpadding="0" cellspacing="0" align="right">
        <tr>
          <td style="font-weight:bold;font-size:11pt;padding-right:8px;">Total</td>
          <td style="font-weight:bold;font-size:11pt;border:1.5px solid #000;padding:3px 12px 3px 24px;text-align:right;min-width:120px;">
            ${fmt(inv.total)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<div style="margin-top:14px;">
  <div style="font-weight:bold;font-size:9pt;text-decoration:underline;margin-bottom:4px;">COMPANY POLICIES :</div>
  <ol style="padding-left:16px;font-size:7.8pt;line-height:1.65;">
    <li style="margin-bottom:2px;">All cheques should be crossed and made payable to Excellent Travel Services and Management 88 Sdn. Bhd.</li>
    <li style="margin-bottom:2px;">Payment by CASH, GIRO OR E-Payment to <strong>Public Bank Berhad with Account No: 3218366910 &amp; Account Holder: Excellent Travel Services and Management 88 Sdn. Bhd.</strong></li>
    <li style="margin-bottom:2px;">Please send the payment advice/bank-in slip stating the Invoice Number to the following email addresses, <strong>etsmfinance@gmail.com OR WhatsApp to Mobile No: +60 12-606 1728</strong>.</li>
    <li style="margin-bottom:2px;">For Tour/Trip, the maximum usage of company vehicle is 10 hrs/day. After 10 hrs, overtime transportation fees will be charged. The maximum 10 hrs of usage of company vehicle is calculated from pick up time to drop off time, if the customers do not use the company vehicle between the pick up time and drop off time, i.e. customers rest in hotel and etc., this duration is counted and will also be included in the 10 hrs of usage.</li>
    <li style="margin-bottom:2px;">For Tour/Trip, if customers request driver to pick up tour guide, more fees will be charged.</li>
    <li style="margin-bottom:2px;">For Ride, the fee charged is for ride only, if customers request driver to pick up tour guide or stop at other locations for meals and etc., extra fees will be charged.</li>
    <li style="margin-bottom:2px;">"TOTAL" amount includes toll, petrol, parking, driver, driver's food and accommodation.</li>
    <li style="margin-bottom:2px;">"TOTAL" amount does not include customers' entry tickets to tourist attractions, food and accommodation.</li>
    <li style="margin-bottom:2px;">For Pick Up from airport,<br>
      <span style="margin-left:12px;">(i) Extra fees will be charged if customers reach the pick up point after 1.5 hrs from the plane arrival time.</span><br>
      <span style="margin-left:12px;">(ii) Company will follow the plane arrival time for pick up of customers. If the plane arrival time changes (earlier or later), company has the right to cancel the pick up arrangement or will arrange for other transportation company to execute the job for pick up of customers.</span>
    </li>
    <li style="margin-bottom:2px;">For cancellation, deposit or 50% from total amount paid is non-refundable.</li>
    <li style="margin-bottom:2px;">Balance must be fully paid on the last day of the tour/ride.</li>
    <li style="margin-bottom:2px;">Balance paid is non-refundable.</li>
    <li style="margin-bottom:2px;">All fees in the invoice are considered as final. There will be no deduction/refund of fees when customers change the plan, i.e. reduce the hours/locations. If customers increase the hours/locations, extra fees will be charged.</li>
    <li style="margin-bottom:2px;">Company is not responsible if customers miss their flight/ferry/boat/cruise, so, customers are advised to start their journey as early as possible.</li>
    <li style="margin-bottom:2px;">Company is not responsible for customers' loss (handphone, belongings and etc.), so, customers are advised to take good care of their own belongings.</li>
    <li style="margin-bottom:2px;">For customers travelling to other countries with our company's transportation services, they must remember to bring their passports.</li>
  </ol>
</div>

<div class="page2" style="padding-top:40mm;text-align:center;font-style:italic;font-size:8.5pt;">
  This is computer generated invoice. No signature is required.
</div>

</body>
</html>`;
}
