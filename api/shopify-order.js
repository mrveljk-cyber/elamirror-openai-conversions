import crypto from "crypto";

export const config = { api: { bodyParser: false } };

const OPENAI_PIXEL_ID = process.env.OPENAI_PIXEL_ID;
const OPENAI_ADS_API_KEY = process.env.OPENAI_ADS_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const EXPECTED_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || "wm12u5-wj.myshopify.com";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function validHmac(rawBody, provided) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  if (!provided) return false;
  const computed = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest("base64");
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(computed, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function orderEventId(order) {
  const id = String(order.id || "").replace(/^gid:\/\/shopify\/Order\//, "");
  return id ? `gid://shopify/Order/${id}` : String(order.checkout_token || order.token || "");
}

function extractOppref(order) {
  const direct = [order.oppref, order.landing_site, order.source_url, order.referring_site];
  for (const value of direct) {
    if (!value) continue;
    if (typeof value === "string" && !value.includes("?") && value.startsWith("oppref_")) return value;
    try {
      const url = new URL(value, "https://elamirror.de");
      const oppref = url.searchParams.get("oppref");
      if (oppref) return oppref;
    } catch {}
  }
  for (const attr of order.note_attributes || []) {
    if (["oppref", "__oppref"].includes(String(attr?.name || "").toLowerCase()) && attr?.value) {
      return String(attr.value);
    }
  }
  return undefined;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody = await readRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];

    if (!validHmac(rawBody, hmac)) return res.status(401).json({ error: "Invalid Shopify signature" });
    if (topic && topic !== "orders/create") return res.status(400).json({ error: "Unexpected Shopify topic" });
    if (shop && EXPECTED_SHOP && shop !== EXPECTED_SHOP) return res.status(403).json({ error: "Unexpected Shopify shop" });

    const order = JSON.parse(rawBody.toString("utf8"));
    const email = order.email || order.customer?.email || order.contact_email;
    const customerId = order.customer?.id || order.customer_id || order.id;
    const amount = Math.round(Number(order.total_price || 0) * 100);
    const currency = order.currency || order.presentment_currency || "EUR";
    const eventId = orderEventId(order);
    const oppref = extractOppref(order);
    const timestampMs = order.created_at ? Date.parse(order.created_at) : Date.now();

    const user = {};
    if (email) user.emails_sha256 = [sha256(email)];
    if (customerId) user.external_ids_sha256 = [sha256(String(customerId))];
    if (order.billing_address?.country_code) user.countries = [order.billing_address.country_code];
    if (order.billing_address?.zip) user.postal_codes = [String(order.billing_address.zip)];
    if (order.billing_address?.city) user.cities = [String(order.billing_address.city)];

    const payload = {
      events: [{
        id: eventId,
        type: "order_created",
        timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
        action_source: "web",
        source_url: "https://elamirror.de",
        ...(oppref ? { oppref } : {}),
        user,
        data: { type: "contents", amount, currency }
      }]
    };

    const response = await fetch(`https://bzr.openai.com/v1/events?pid=${OPENAI_PIXEL_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_ADS_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.text();
    if (!response.ok) {
      console.error("OpenAI error:", result);
      return res.status(500).json({ error: "OpenAI conversion failed", details: result });
    }

    return res.status(200).json({ success: true, event_id: eventId, openai: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
