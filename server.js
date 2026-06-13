import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
const PORT = 3000;

const CORS_ORIGINS = ["http://localhost:5173", "https://checkx.vercel.app"];

app.use(
  cors({
    origin: CORS_ORIGINS,
  })
);

/* =========================
   COMMON HELPERS
========================= */

function cleanText(text = "") {
  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value) {
  if (!value) return null;

  const match = String(value).match(/-?[\d,.]+/);
  if (!match) return null;

  return Number(match[0].replace(/,/g, ""));
}

function parseCurrencyFromAmountLine(value) {
  if (!value) return null;
  const m = String(value).match(/\b([A-Z]{3})\b/);
  return m ? m[1] : null;
}

/* =========================
   TELEBIRR SCRAPER
========================= */

function findTelebirrValue($, label) {
  let result = null;

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => cleanText($(td).text()))
      .get()
      .filter(Boolean);

    if (cells.length < 2) return;

    const left = cells[0];
    const right = cells[cells.length - 1];

    if (left.toLowerCase().includes(label.toLowerCase())) {
      result = right;
    }
  });

  return result;
}

function findTelebirrInvoiceData($) {
  let invoiceNo = null;
  let paymentDate = null;
  let amount = null;

  $("tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .map((_, td) => cleanText($(td).text()))
      .get()
      .filter(Boolean);

    if (cells.length >= 3) {
      const first = cells[0];
      const second = cells[1];
      const third = cells[2];

      const looksLikeInvoice = /^[A-Z0-9]+$/i.test(first);
      const looksLikeDate = /\d{2}-\d{2}-\d{4}/.test(second);

      if (looksLikeInvoice && looksLikeDate) {
        invoiceNo = first;
        paymentDate = second;
        amount = parseAmount(third);
      }
    }
  });

  return {
    invoiceNo,
    paymentDate,
    amount,
  };
}

function splitTelebirrDateTime(value) {
  if (!value) {
    return {
      date: null,
      time: null,
    };
  }

  const raw = cleanText(value);

  // App-style: 2026/03/29 14:57:05
  const slash = raw.match(
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})$/
  );
  if (slash) {
    return {
      date: `${slash[1]}-${slash[2]}-${slash[3]}`,
      time: slash[4],
    };
  }

  // Web receipt-style: 07-05-2026 17:41:13
  const parts = raw.split(" ");

  return {
    date: parts[0] || null,
    time: parts[1] || null,
  };
}

function telebirrDateTimeToIso(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const dmy = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const isoLocal = `${dmy[3]}-${dmy[2]}-${dmy[1]}T${timeStr}`;
    const ms = Date.parse(isoLocal);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  const ymd = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const isoLocal = `${ymd[1]}-${ymd[2]}-${ymd[3]}T${timeStr}`;
    const ms = Date.parse(isoLocal);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  return null;
}

async function scrapeTelebirrReceipt(receiptId) {
  const url = `https://transactioninfo.ethiotelecom.et/receipt/${receiptId}`;

  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);


  $("script, style").remove();

  const invoice = findTelebirrInvoiceData($);

  const transactionNumber =
    findTelebirrValue($, "Transaction Number") || invoice.invoiceNo;

  const transactionTimeRaw =
    findTelebirrValue($, "Transaction Time") || invoice.paymentDate;

  const dateTime = splitTelebirrDateTime(transactionTimeRaw);

  const amountLine =
    findTelebirrValue($, "Amount") ||
    findTelebirrValue($, "Paid Amount") ||
    findTelebirrValue($, "Transaction Amount");

  const amountFromLine = amountLine ? parseAmount(amountLine) : null;
  const amount = amountFromLine ?? invoice.amount;
  const currency =
    parseCurrencyFromAmountLine(amountLine) ||
    (String(amountLine || "").toLowerCase().includes("etb") ? "ETB" : null);

  const receiver =
    findTelebirrValue($, "Transaction To") ||
    findTelebirrValue($, "Receiver Name");

  const transaction_type = findTelebirrValue($, "Transaction Type");

  const occurred_at = telebirrDateTimeToIso(dateTime.date, dateTime.time);

  return {
    provider: "telebirr",
    transaction_id: transactionNumber,
    date: dateTime.date,
    time: dateTime.time,
    occurred_at,
    amount,
    currency: currency || "ETB",
    transaction_type,
    sender: findTelebirrValue($, "Payer Name"),
    receiver: receiver || null,
  };
}



const CBE_API_BASE =
  "https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail";

// Header values are embedded in the CBE web app's JS bundle and are
// required by the API; without them the server returns 400.
const CBE_API_HEADERS = {
  "X-App-ID": "d1292e42-7400-49de-a2d3-9731caa4c819",
  "X-App-Version": "0a01980b-9859-1369-8198-59f403820000",
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json",
};

function normalizeCbeReceiptId(rawId) {
  const trimmed = String(rawId || "").trim();
  if (!trimmed) return null;

  const fromUrl = trimmed.match(
    /(?:mbreciept\.cbe\.com\.et|mb\.cbe\.com\.et)\/([^\/?#]+)/i
  );
  if (fromUrl) return fromUrl[1];

  return trimmed;
}

function isValidCbeReceiptId(id) {
  // Legacy: FT26132S41Y6-85094136
  // V2: v2-hfHCxzixhYQx8V4BijpP
  return (
    /^FT[A-Z0-9]+-\d+$/i.test(id) || /^v2-[A-Za-z0-9]+$/i.test(id)
  );
}

// Convert "20260512" -> "2026-05-12"
function formatCbeDate(yyyymmdd) {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(
    6,
    8
  )}`;
}

// "2026-05-12T03:38:00Z" -> { date: "2026-05-12", time: "03:38:00" }
function splitCbeIsoDateTime(iso) {
  if (!iso) return { date: null, time: null };
  const match = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (!match) return { date: null, time: null };
  return { date: match[1], time: match[2] };
}

async function scrapeCbeReceipt(receiptId) {
  const normalizedId = normalizeCbeReceiptId(receiptId);
  if (!normalizedId || !isValidCbeReceiptId(normalizedId)) {
    throw new Error(
      "Invalid CBE receipt id. Expected format: FT26132S41Y6-85094136 or v2-hfHCxzixhYQx8V4BijpP"
    );
  }

  const isV2 = /^v2-/i.test(normalizedId);
  const apiReceiptId = isV2 ? normalizedId : normalizedId.toUpperCase();
  const url = `${CBE_API_BASE}/${apiReceiptId}`;

  const response = await axios.get(url, {
    headers: CBE_API_HEADERS,
    timeout: 15000,
  });

  const data = response.data || {};

  const isoDateTime =
    Array.isArray(data.dateTimes) && data.dateTimes.length > 0
      ? data.dateTimes[0]
      : null;
  const { date: isoDate, time } = splitCbeIsoDateTime(isoDateTime);
  const date = isoDate || formatCbeDate(data.processingDate);
  const occurred_at = isoDateTime || null;

  const transactionType =
    (Array.isArray(data.paymentDetails) && data.paymentDetails[0]) ||
    data.transactionType ||
    null;

  return {
    provider: "cbe",
    transaction_id:
      data.id || (isV2 ? null : apiReceiptId.split("-")[0]) || apiReceiptId,
    date,
    time,
    occurred_at,
    amount: parseAmount(
      data.amountCredited ?? data.creditAmount ?? data.debitAmount
    ),
    currency: data.creditCurrency || data.debitCurrency || "ETB",
    transaction_type: transactionType,
    sender: data.debitAccountHolder || null,
    receiver: data.creditAccountHolder || null,
  };
}

/* =========================
   ROUTES
========================= */

app.get("/", (req, res) => {
  res.json({
    message: "Receipt scraper API is running",
    endpoints: {
      telebirr: "/receipt/telebirr/:id",
      cbe: "/receipt/cbe/:receiptId",
    },
    examples: {
      telebirr: "/receipt/telebirr/984559233",
      cbe: "/receipt/cbe/v2-hfHCxzixhYQx8V4BijpP",
    },
  });
});

app.get("/receipt/telebirr/:id", async (req, res) => {
  try {
    const data = await scrapeTelebirrReceipt(req.params.id);
    res.json(data);
  } catch (error) {
    console.error("Telebirr error:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch Telebirr receipt",
      error: error.message,
    });
  }
});

app.get("/receipt/cbe/:id", async (req, res) => {
  try {
    const data = await scrapeCbeReceipt(req.params.id);
    res.json(data);
  } catch (error) {
    console.error("CBE error:", error.message);

    const apiDetail = String(error.response?.data?.detail || "");
    const status =
      error.response?.status === 404
        ? 404
        : error.response?.status === 500 &&
          apiDetail.toLowerCase().includes("invalid v2 token")
        ? 404
        : error.message.startsWith("Invalid CBE")
        ? 400
        : 500;

    res.status(status).json({
      success: false,
      message: "Failed to fetch CBE receipt",
      error: error.message,
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Telebirr: http://localhost:${PORT}/receipt/telebirr/984559233`);
  console.log(
    `CBE: http://localhost:${PORT}/receipt/cbe/v2-hfHCxzixhYQx8V4BijpP`
  );
});