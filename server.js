/**
 * J.HINTON Stripe Checkout backend (Render-ready)
 * - Creates Checkout Sessions using server-side prices (prevents tampering)
 * - Shipping address collection (US only)
 * - Shipping options:
 * Express (1–2 Days) $29.99
 * Standard (2–5 Days) $12.95
 * Free shipping when subtotal >= $150.00
 * - Webhook verifies payment and sends order email (Resend) to customer + internal
 *
 * ENV (Render):
 * STRIPE_SECRET_KEY=sk_...
 * SITE_URL=https://j-hinton.com
 * ALLOWED_ORIGINS=https://j-hinton.com (comma-separated allowed origins OK)
 * STRIPE_WEBHOOK_SECRET=whsec_... (set after you create webhook endpoint in Stripe)
 * RESEND_API_KEY=re_... (optional but recommended)
 * FROM_EMAIL=orders@j-hinton.com
 * INTERNAL_ORDER_EMAIL=ordersupport@j-hinton.com
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
let Resend;
try { Resend = require("resend").Resend; } catch (_) { Resend = null; }

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SITE_URL = process.env.SITE_URL;

if (!STRIPE_SECRET_KEY) {
  console.error("Missing STRIPE_SECRET_KEY");
  process.exit(1);
}
if (!SITE_URL) {
  console.error("Missing SITE_URL");
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const app = express();

// CORS (allow your site + local dev)
const allowed = (process.env.ALLOWED_ORIGINS || SITE_URL || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ✅ PRODUCTION CORS: RE-ENABLING SECURE LOGIC
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    // Allowing the local development environment is often necessary
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        return cb(null, true);
    }
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  }
}));

// Webhook MUST use raw body. Mount before json middleware.
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (whsec) {
      event = stripe.webhooks.constructEvent(req.body, sig, whsec);
    } else {
      // Dev fallback (not secure). Set STRIPE_WEBHOOK_SECRET in production.
      event = JSON.parse(req.body.toString("utf8"));
    }
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Pull expanded details for line items + customer + shipping
      const full = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price.product", "customer", "payment_intent"]
      });

      await sendOrderEmails(full);
    }
  } catch (err) {
    console.error("Webhook handling error:", err);
    // Return 200 so Stripe doesn't retry forever if email provider is down.
  }

  res.json({ received: true });
});

// JSON middleware for normal routes
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });

// ===============================
// Klaviyo Subscribe (Email + optional SMS)
// ENV:
//  KLAVIYO_PRIVATE_KEY=pk_...
//  KLAVIYO_LIST_ID=LIST_ID
// ===============================
app.post("/api/klaviyo/subscribe", async (req, res) => {
  try {
    const {
      email,
      phone,
      first_name,
      last_name,
      marketing_texts,
      marketing_emails,
      consent
    } = req.body || {};

    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });
    if (!consent) return res.status(400).json({ ok: false, error: "Consent required" });

    const KLAVIYO_PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY;
    const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

    if (!KLAVIYO_PRIVATE_KEY || !KLAVIYO_LIST_ID) {
      return res.status(500).json({ ok: false, error: "Klaviyo env vars missing" });
    }

    const cleanPhone = phone ? String(phone).replace(/\D/g, "") : "";
    const phone_number = cleanPhone ? `+1${cleanPhone}` : undefined;

    const payload = {
      data: {
        type: "profile-subscription-bulk-create-job",
        attributes: {
          list_id: KLAVIYO_LIST_ID,
          subscriptions: {
            email: {
              marketing: { consent: "SUBSCRIBED" }
            },
            ...(marketing_texts && phone_number
              ? { sms: { marketing: { consent: "SUBSCRIBED" } } }
              : {})
          },
          profiles: [
            {
              type: "profile",
              attributes: {
                email,
                first_name,
                last_name,
                ...(phone_number ? { phone_number } : {}),
                properties: {
                  marketing_emails: !!marketing_emails,
                  marketing_texts: !!marketing_texts,
                  source: "jhinton-home-join"
                }
              }
            }
          ]
        }
      }
    };

    const resp = await fetch("https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/", {
      method: "POST",
      headers: {
        "Authorization": `Klaviyo-API-Key ${KLAVIYO_PRIVATE_KEY}`,
        "Content-Type": "application/json",
        "revision": "2024-10-15"
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(400).json({ ok: false, error: "Klaviyo error", details: data });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("klaviyo subscribe error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

});

const PRODUCTS_PATH = path.join(__dirname, "products.json");
const PRODUCTS = JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf8"));

// Helper: allow "sku--size" in frontend; normalize to base sku.
function normalizeSku(rawSku) {
  if (!rawSku) return "";
  return String(rawSku).split("--")[0].trim();
}

// ✅ NEW HELPER: Extract the size/variant from the full SKU
function extractVariant(rawSku) {
  const parts = String(rawSku || "").split('--');
  if (parts.length > 1) {
    // Join the rest of the parts and convert to uppercase for display
    return parts.slice(1).join('--').trim().toUpperCase(); 
  }
  return '';
}


function computeSubtotalCents(items) {
  let subtotal = 0;
  for (const it of items) {
    const base = normalizeSku(it.sku);
    const qty = Math.max(1, Number(it.qty) || 1);
    const p = PRODUCTS[base];
    if (!p) continue;
    subtotal += (Number(p.price) || 0) * qty;
  }
  return subtotal;
}

function buildShippingOptions(subtotalCents) {
  // Always include Standard + Express. Include Free only if eligible.
  const opts = [];

  if (subtotalCents >= 15000) {
    opts.push({
      shipping_rate_data: {
        display_name: "Free Shipping (Orders $150+)",
        type: "fixed_amount",
        fixed_amount: { amount: 0, currency: "usd" },
        delivery_estimate: {
          minimum: { unit: "business_day", value: 2 },
          maximum: { unit: "business_day", value: 5 }
        }
      }
    });
  }

  opts.push({
    shipping_rate_data: {
      display_name: "Standard (2–5 Days)",
      type: "fixed_amount",
      fixed_amount: { amount: 1295, currency: "usd" },
      delivery_estimate: {
        minimum: { unit: "business_day", value: 2 },
        maximum: { unit: "business_day", value: 5 }
      }
    }
  });

  opts.push({
    shipping_rate_data: {
      display_name: "Express (1–2 Days)",
      type: "fixed_amount",
      fixed_amount: { amount: 2999, currency: "usd" },
      delivery_estimate: {
        minimum: { unit: "business_day", value: 1 },
        maximum: { unit: "business_day", value: 2 }
      }
    }
  });

  return opts;
}

app.post("/create-checkout-session", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Cart is empty" });

    // Build Stripe line_items from server-side catalog
    const line_items = [];
    const metadata = {};

    for (const it of items) {
      const rawSku = String(it.sku || "").trim();
      const baseSku = normalizeSku(rawSku);
      const variant = extractVariant(rawSku); // ✅ NEW: Extract variant
      const qty = Math.max(1, Number(it.qty) || 1);

      const p = PRODUCTS[baseSku];
      if (!p || !p.price) {
        return res.status(400).json({ error: `Unknown or inactive product: ${baseSku}` });
      }

      // pass size info (if sku includes --SIZE)
      if (variant) metadata[`size_${baseSku}`] = variant;

      line_items.push({
        price_data: {
          currency: p.currency || "usd",
          unit_amount: Number(p.price),
          product_data: {
            name: p.name || baseSku,
            // ✅ CRITICAL FIX: Append the variant to the product description
            description: variant ? `Size: ${variant}` : p.description || 'Apparel',
            images: p.image ? [p.image] : [],
            metadata: { sku: baseSku, ...(variant ? { variant } : {}) } // changed 'size' to 'variant' for consistency
          }
        },
        quantity: qty
      });
    }

    const subtotal = computeSubtotalCents(items);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,

      // ✅ Stripe Automatic Tax
      automatic_tax: { enabled: true },

      // ✅ Collect billing address for tax calculation
      billing_address_collection: "required",

      // Shipping: collect address (US only) + options
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: buildShippingOptions(subtotal),

      // Let Stripe collect email + show receipts (you turned it on in dashboard)
      phone_number_collection: { enabled: true },

      // Success / Cancel
      success_url: `${SITE_URL.replace(/\/$/, "")}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL.replace(/\/$/, "")}/cancel.html`,

      // Metadata for internal order email
      metadata: {
        source: "jhinton-site",
        ...metadata
      }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

async function sendOrderEmails(session) {
  const internalTo = process.env.INTERNAL_ORDER_EMAIL || "";
  const from = process.env.FROM_EMAIL || "orders@j-hinton.com";
  const resendKey = process.env.RESEND_API_KEY || "";

  const customerEmail =
    session.customer_details?.email ||
    session.customer?.email ||
    "";

  const ship = session.shipping_details || {};
  const addr = ship.address || {};

  const lines = [];
  const items = session.line_items?.data || [];
  for (const li of items) {
    const name = li.description || li.price?.product?.name || "Item";
    const qty = li.quantity || 1;
    const unit = li.price?.unit_amount || 0;
    // Note: The metadata on the session itself might be the easiest way to get the size for the email
    const variant = li.price?.product?.description?.startsWith('Size:') ? li.price.product.description.replace('Size: ', '') : '';
    lines.push(`${qty} × ${name}${variant ? " (" + variant + ")" : ""} — $${(unit/100).toFixed(2)}`);
  }

  const amountTotal = session.amount_total ? `$${(session.amount_total/100).toFixed(2)}` : "—";
  const amountShipping = session.total_details?.amount_shipping != null ? `$${(session.total_details.amount_shipping/100).toFixed(2)}` : "—";

  const subject = `J.HINTON Order Confirmed — ${amountTotal}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">
      <h2 style="letter-spacing:.12em;text-transform:uppercase;font-weight:700;margin:0 0 12px">Order Confirmed</h2>
      <p style="margin:0 0 16px;color:#444;line-height:1.6">
        Thank you for your purchase. Your order is confirmed and is being prepared for shipment.
      </p>

      <div style="border:1px solid #e7e7e7;padding:16px;margin:16px 0">
        <div style="font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:12px;margin-bottom:8px">Order Details</div>
        <div style="font-size:14px;line-height:1.7;color:#333">
          ${lines.map(l => `<div>${escapeHtml(l)}</div>`).join("")}
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:12px 0"/>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#333"><span>Shipping</span><span>${amountShipping}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:#333;margin-top:6px"><span>Total</span><span style="font-weight:800">${amountTotal}</span></div>
      </div>

      <div style="border:1px solid #e7e7e7;padding:16px;margin:16px 0">
        <div style="font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:12px;margin-bottom:8px">Shipping Address</div>
        <div style="font-size:13px;line-height:1.6;color:#333">
          ${(ship.name||"").toString()}<br/>
          ${(addr.line1||"").toString()} ${(addr.line2||"").toString()}<br/>
          ${(addr.city||"").toString()}, ${(addr.state||"").toString()} ${(addr.postal_code||"").toString()}<br/>
          ${(addr.country||"").toString()}
        </div>
      </div>

      <p style="font-size:12px;color:#666;line-height:1.6">
        Need help? Reply to this email or contact <a href="mailto:${escapeHtml(internalTo)}" style="color:#111;text-decoration:underline">${escapeHtml(internalTo)}</a>.
      </p>
      <p style="font-size:11px;color:#888;margin-top:16px;text-transform:uppercase;letter-spacing:.06em">
        © ${new Date().getFullYear()} J.HINTON INC
      </p>
    </div>
  `;

  // If Resend isn't configured, just log (so checkout still works).
  if (!Resend || !resendKey) {
    console.log("[order-email] RESEND_API_KEY not set. Would send to:", customerEmail, "and", internalTo);
    return;
  }

  const resend = new Resend(resendKey);

  // Send to customer
  if (customerEmail) {
    await resend.emails.send({
      from,
      to: customerEmail,
      subject,
      html
    });
  }

  // Send internal copy
  if (internalTo) {
    await resend.emails.send({
      from,
      to: internalTo,
      subject: "[INTERNAL] " + subject,
      html: html.replace("Order Confirmed", "Order Confirmed (Internal Copy)")
    });
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Checkout backend running on port", port));
