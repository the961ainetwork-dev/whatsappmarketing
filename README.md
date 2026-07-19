# WA-Marketer — Multi-tenant WhatsApp Marketing SaaS

Broadcast campaigns · Claude AI auto-responder · Lead capture · Drip sequences.
Each customer connects their OWN Meta WhatsApp Cloud API credentials.

## Deploy (15 min)
1. Create a NEW Supabase project (or reuse) → SQL Editor → run `setup.sql`
2. Create a NEW Vercel project → import this repo/folder
3. Vercel → Settings → Environment Variables:
   - SUPABASE_SERVICE_KEY  (sb_secret_… from Supabase)
   - WM_SUPABASE_URL       (https://YOURPROJECT.supabase.co — optional if same as default)
   - ANTHROPIC_API_KEY     (for the AI responder)
   - WM_VERIFY_TOKEN       (any string, default: wamark-verify)
4. Deploy. Open the site → create your first account.

## Per-customer WhatsApp setup (they do once, ~10 min, free)
1. developers.facebook.com → Create App (type: Business) → add WhatsApp product
2. WhatsApp → API Setup → copy Phone Number ID
3. Business Settings → System Users → create → generate PERMANENT token
   with whatsapp_business_messaging + whatsapp_business_management
4. WhatsApp → Configuration → Webhook:
   - Callback URL: https://YOUR-DOMAIN/api/webhook
   - Verify token: wamark-verify
   - Subscribe to: messages
5. Paste Phone Number ID + token in the app's Settings → Send test

## Notes
- Outbound to cold contacts REQUIRES approved templates (Meta Business Manager → Message Templates)
- Free text works only within 24h of the contact's last inbound message
- Cron runs every 15 min: sends due drip steps + scheduled/large campaigns (30 msgs/batch)
- Meta free tier: 1,000 service conversations/month per number
