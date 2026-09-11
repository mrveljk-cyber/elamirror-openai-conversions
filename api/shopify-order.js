import crypto from "crypto";

const OPENAI_PIXEL_ID = process.env.OPENAI_PIXEL_ID;
const OPENAI_ADS_API_KEY = process.env.OPENAI_ADS_API_KEY;

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const order = req.body;

    const email =
      order.email ||
      order.customer?.email ||
      order.contact_email;

    const customerId =
      order.customer?.id ||
      order.customer_id ||
      order.id;

    const amount = Math.round(
      Number(order.total_price || 0) * 100
    );

    const currency =
      order.currency ||
      order.presentment_currency ||
      "EUR";

    const eventId = String(order.id);

    const user = {};

    if (email) {
      user.emails_sha256 = [sha256(email)];
    }

    if (customerId) {
      user.external_ids_sha256 = [
        sha256(String(customerId))
      ];
    }

    if (order.billing_address?.country_code) {
      user.countries = [
        order.billing_address.country_code
      ];
    }

    if (order.billing_address?.zip) {
      user.postal_codes = [
        String(order.billing_address.zip)
      ];
    }

    if (order.billing_address?.city) {
      user.cities = [
        String(order.billing_address.city)
      ];
    }

    const payload = {
      events: [
        {
          id: eventId,
          type: "order_created",
          timestamp_ms: Date.now(),
          action_source: "web",
          user,
          data: {
            type: "contents",
            amount,
            currency
          }
        }
      ]
    };

    const response = await fetch(
      `https://bzr.openai.com/v1/events?pid=${OPENAI_PIXEL_ID}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_ADS_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.text();

    if (!response.ok) {
      console.error("OpenAI error:", result);

      return res.status(500).json({
        error: "OpenAI conversion failed",
        details: result
      });
    }

    return res.status(200).json({
      success: true,
      openai: result
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
