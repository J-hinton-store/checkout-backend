import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Stripe from "stripe";

dotenv.config();
const app = express();

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SITE_URL,
  ALLOWED_ORIGINS,
  SHIPPING_USD_CENTS = "1500",
  CURRENCY = "usd"
} = process.env;

if (!STRIPE_SECRET_KEY) { console.error("Missing STRIPE_SECRET_KEY"); process.exit(1); }
if (!SITE_URL) { console.error("Missing SITE_URL"); process.exit(1); }

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const productsPath = path.join(process.cwd(), "products.json");
const PRODUCT_CATALOG = JSON.parse(fs.readFileSync(productsPath, "utf8"));

const allowedOrigins = (ALLOWED_ORIGINS || SITE_URL).split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin), false);
  }
}));

app.get("/health", (_req, res) => res.json({ ok: true }));

// JSON for normal routes
app.use(express.json({ limit: "1mb" }));

function buildLineItems(items){
  if (!Array.isArray(items) || items.length === 0) throw new Error("Cart is empty.");
  return items.map(({ sku, qty }) => {
    const key = String(sku || "").trim();
    const product = PRODUCT_CATALOG[key];
    const quantity = Math.max(1, Math.min(99, parseInt(qty, 10) || 1));
    if (!product) throw new Error("Invalid SKU: " + key);
    return {
      quantity,
      price_data: {
        currency: (CURRENCY || "usd").toLowerCase(),
        unit_amount: product.price_cents,
        product_data: {
          name: product.name,
          images: product.image ? [product.image] : undefined,
          metadata: { sku: key }
        }
      }
    };
  });
}

app.post("/create-checkout-session", async (req, res) => {
  try{
    const { items } = req.body || {};
    const line_items = buildLineItems(items);
    const shippingCents = parseInt(SHIPPING_USD_CENTS, 10) || 0;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: shippingCents > 0 ? [{
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: shippingCents, currency: (CURRENCY || "usd").toLowerCase() },
          display_name: "Standard Shipping",
          delivery_estimate: {
            minimum: { unit: "business_day", value: 3 },
            maximum: { unit: "business_day", value: 7 }
          }
        }
      }] : undefined,
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/cart.html`,
      metadata: { source: "jhinton-hostinger" }
    });

    res.json({ url: session.url });
  }catch(err){
    res.status(400).json({ error: err.message || "Checkout error" });
  }
});

app.get("/checkout-session/:id", async (req, res) => {
  try{
    const session = await stripe.checkout.sessions.retrieve(req.params.id, { expand: ["payment_intent"] });
    res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_details: session.customer_details
    });
  }catch(err){
    res.status(400).json({ error: err.message || "Session lookup error" });
  }
});

// Webhook: raw body is required
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  const sig = req.headers["stripe-signature"];
  let event;
  try{
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  }catch(err){
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    console.log("✅ checkout.session.completed", {
      id: session.id,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      email: session.customer_details?.email
    });
  }

  res.json({ received: true });
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log("Stripe backend running on port", port));
