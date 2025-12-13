# J.HINTON Stripe Checkout Backend (Render)

## Endpoints
- POST /create-checkout-session  -> returns Stripe Checkout URL
- POST /webhook                  -> verifies Stripe signature + logs successful checkouts
- GET  /checkout-session/:id     -> for success.html

## Render setup
Build Command: `npm install`
Start Command: `node server.js`

Env Vars to add on Render:
- STRIPE_SECRET_KEY
- SITE_URL = https://j-hinton.com
- ALLOWED_ORIGINS = https://j-hinton.com
- SHIPPING_USD_CENTS = 1500 (edit anytime)
- CURRENCY = usd

After deploy:
Stripe Dashboard -> Developers -> Webhooks -> Add endpoint
Endpoint URL: https://YOUR-RENDER-URL.onrender.com/webhook
Events: checkout.session.completed
Reveal signing secret -> set STRIPE_WEBHOOK_SECRET on Render -> redeploy.
