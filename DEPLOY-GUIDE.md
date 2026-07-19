# 🚀 WA-MARKETER — COMPLETE DEPLOYMENT GUIDE (A → Z)

Multi-tenant WhatsApp Marketing SaaS: AI sales responder · broadcast campaigns ·
smart segments · drip sequences · hot-lead alerts · daily owner reports ·
anti-ban protection · Pro analytics · agency workspaces · admin control room.

Time needed: ~30 minutes. Cost to run: $0 (free tiers) + Anthropic API usage.

─────────────────────────────────────────────────────────────────
## PART 1 — SUPABASE (the database) · 5 min
─────────────────────────────────────────────────────────────────
1. Go to https://supabase.com → New project
   - Name: wamarketer · pick a strong DB password · region: closest to you
2. Wait for the project to initialize (~2 min)
3. Left sidebar → SQL Editor → New query
4. Open `setup.sql` from this zip → copy ALL of it → paste → click RUN
   ("Success. No rows returned" = correct)
5. Left sidebar → Settings (gear) → API Keys:
   - Click "New secret key" → name it `vercel_backend` → Create → COPY the
     `sb_secret_...` value now (shown once). This is your SUPABASE_SERVICE_KEY.
6. Same page, note your Project URL: `https://XXXX.supabase.co`
   → this is your WM_SUPABASE_URL.

─────────────────────────────────────────────────────────────────
## PART 2 — GITHUB (the code) · 3 min
─────────────────────────────────────────────────────────────────
1. github.com → New repository → name: `wamarketer` → Private → Create
2. "uploading an existing file" link → drag EVERYTHING from this zip:
   - index.html, setup.sql, vercel.json, README.md, DEPLOY-GUIDE.md
   - then open the `api` folder view: Add file → Upload → drag ALL 13 .js files
     ⚠️ Make sure they land INSIDE `api/` (create it by typing `api/auth.js` in
     "Create new file" first if drag-drop flattens folders)
3. Commit. Final tree must look like:
   ├── api/ (13 files: _lib, admin, ai-writer, analytics, auth, campaigns,
   │        contacts, daily-summary, drip-cron, drips, health, messages,
   │        settings, webhook, workspaces)
   ├── index.html
   ├── setup.sql
   └── vercel.json

─────────────────────────────────────────────────────────────────
## PART 3 — VERCEL (hosting + crons) · 7 min
─────────────────────────────────────────────────────────────────
⚠️ Crons every 15 min require Vercel PRO. On Hobby, change vercel.json
   cron schedules to once daily (e.g. "0 5 * * *") — drips/campaigns then
   process once a day instead of every 15 min.

1. vercel.com → Add New → Project → Import your `wamarketer` repo
2. Framework preset: **Other** (it's a static index.html + /api functions)
3. BEFORE deploying → Environment Variables — add these 5:

   | Name                 | Value                                   |
   |----------------------|-----------------------------------------|
   | SUPABASE_SERVICE_KEY | sb_secret_… (from Part 1 step 5)        |
   | WM_SUPABASE_URL      | https://XXXX.supabase.co (Part 1 step 6)|
   | ANTHROPIC_API_KEY    | sk-ant-… (console.anthropic.com)        |
   | WM_VERIFY_TOKEN      | wamark-verify  (or your own string)     |
   | WM_ADMIN_PASS        | YOUR-STRONG-ADMIN-PASSWORD ← CHANGE IT! |

   Optional: WM_BRAND_FOOTER = "AI by WA-Marketer — yourdomain.com"
   (appears under AI replies of demo/free accounts — your growth loop)

4. Click Deploy → wait for green ✓
5. Note your URL: https://wamarketer-xxxx.vercel.app
   (add a custom domain later in Settings → Domains)

─────────────────────────────────────────────────────────────────
## PART 4 — EDIT 1 NUMBER IN THE CODE · 1 min
─────────────────────────────────────────────────────────────────
In `index.html`, find `9613000000` (appears 2×: concierge links) and replace
with YOUR WhatsApp number (with country code). Commit → auto-redeploys.

─────────────────────────────────────────────────────────────────
## PART 5 — SMOKE TEST (no WhatsApp needed yet) · 5 min
─────────────────────────────────────────────────────────────────
1. Open your Vercel URL → click "⚡ Try 24-hour demo" → you land on the
   dashboard with the demo banner. ✓
2. Contacts → add one (any phone) → appears in table. ✓
3. Campaigns → "✨ AI writes your message" → type an offer → Write it →
   you get a template name + body. ✓ (proves ANTHROPIC_API_KEY works)
4. Logout → Admin link (bottom of login card) → enter WM_ADMIN_PASS →
   you see the demo user, totals, and the activity feed. ✓
5. In Admin: create a real account first (signup on login page), then
   approve it (✅) and set its plan (e.g. pro) from the dropdown.

─────────────────────────────────────────────────────────────────
## PART 6 — WHATSAPP CONNECTION (each customer does this once) · 10 min
─────────────────────────────────────────────────────────────────
Prereq: a phone number NOT already on WhatsApp/WhatsApp Business app
(or willing to migrate). Meta gives a free test number too.

1. https://developers.facebook.com/apps → Create App → Type: **Business**
2. Inside the app → Add product → **WhatsApp** → Set up
3. WhatsApp → **API Setup**:
   - Under "From": copy the **Phone Number ID** (a long number)
   - Add your personal phone under "To" as a test recipient
4. PERMANENT TOKEN (the API Setup token dies in 24h — don't use it):
   - https://business.facebook.com/settings/system-users → Add →
     name: wamarketer, role: Admin → Create
   - Click the system user → **Assign assets** → select your App → full control
   - **Generate token** → select the app → check:
       ✓ whatsapp_business_messaging
       ✓ whatsapp_business_management
   - Copy the token (starts with EAAG…)
5. WEBHOOK — WhatsApp → **Configuration** → Webhook → Edit:
   - Callback URL:  https://YOUR-VERCEL-URL/api/webhook
   - Verify token:  wamark-verify   (= your WM_VERIFY_TOKEN)
   - Verify & save → then click **Manage** → subscribe to **messages**
6. In WA-Marketer → Settings → paste Business name, Phone Number ID, token
   → Save → enter your phone → **Send test message**
   → the ✅ message arrives on WhatsApp = LIVE 🎉

─────────────────────────────────────────────────────────────────
## PART 7 — ACTIVATE THE MONEY FEATURES · 5 min
─────────────────────────────────────────────────────────────────
A) AI SALES RESPONDER
   AI Responder tab → paste business info (products, prices, delivery,
   tone — Arabic/English) → toggle Enabled → Save.
   Test: message the business number from another phone: "how much is X?"
   → AI answers in your language, and if you show buying intent, the
   OWNER PHONE gets a 🔥 hot-lead alert instantly.
   (Set owner phone in Settings → Daily owner report first.)

B) DAILY OWNER REPORT
   Settings → Daily owner report → your personal number + checkbox → Save.
   Arrives 7:00 AM Beirut (04:00 UTC cron). For guaranteed delivery, either
   message the business number once from your phone ("subscribe"), or create
   a Meta template named `daily_summary` with body:
   📊 Daily report {{1}}: {{2}}

C) FIRST CAMPAIGN
   Meta Business Manager → Message Templates → Create → paste the name+body
   from the ✨ AI writer → submit → once Approved, put the template name in
   the campaign form → pick audience (category or ⚡ smart segment) → Send.
   Warm-up caps apply: day 1-3 = 50/day → 200 → 500 → 1,000. Capped sends
   resume automatically next day (this protects the number).

D) ANALYTICS (Pro)
   Upgrade a user to `pro` in Admin → their campaigns' "📊 stats" button
   unlocks delivery/read/reply/failed rates (fed by Meta status webhooks).

E) AGENCY WORKSPACES
   Set a user's plan to `agency` in Admin → a "Workspaces" tab appears →
   create one workspace per client → "Open →" switches into it (green
   banner shows), "← Back to agency" returns. Each workspace = isolated
   contacts, number, campaigns, AI.

─────────────────────────────────────────────────────────────────
## PART 8 — GO-LIVE CHECKLIST
─────────────────────────────────────────────────────────────────
□ WM_ADMIN_PASS changed from default
□ Concierge number replaced (Part 4)
□ setup.sql ran fully (check Supabase → Table Editor: 9 wm_* tables)
□ Crons visible: Vercel → project → Settings → Cron Jobs (2 entries)
□ Demo flow works end-to-end
□ One real WhatsApp number connected + test message received
□ AI responder answered a real inbound + hot-lead alert fired
□ First template approved in Meta + campaign sent to a small category
□ Admin approved/rejected at least one signup
□ Custom domain added (optional) — then update the webhook URL in Meta!

─────────────────────────────────────────────────────────────────
## TROUBLESHOOTING
─────────────────────────────────────────────────────────────────
• "Webhook verification failed" → verify token in Meta ≠ WM_VERIFY_TOKEN env.
• Test send fails / (#131030) → recipient not in Meta's test list (dev mode),
  or token lacks permissions, or free-text outside 24h window (use template).
• AI doesn't reply → AI toggle off, ANTHROPIC_API_KEY missing, or webhook not
  subscribed to "messages". Check Vercel → Logs → /api/webhook.
• Campaign stuck "sending" → warm-up cap reached (resumes tomorrow) or cron
  not running (Vercel Pro needed for */15).
• Analytics all zeros → Meta statuses arrive on the same webhook; give it
  time after sending, confirm "messages" subscription is active.
• 401 on everything → SUPABASE_SERVICE_KEY wrong or setup.sql not run.
• Token expired after a day → you used the API-Setup token; make the
  System User permanent token (Part 6 step 4).

─────────────────────────────────────────────────────────────────
## SELLING IT (your operating model)
─────────────────────────────────────────────────────────────────
1. Prospects hit your URL → 24h demo, zero friction.
2. They sign up → land in workspace as PENDING (demo limits) → you get them
   in Admin → approve + set plan after payment (WhatsApp/bank in beta).
3. Offer the $25 concierge on every onboarding — it converts and pays you.
4. Demo/free AI replies carry your branded footer → every conversation
   advertises you to exactly your target customer.
5. Upsell path: Starter $29 → Pro $49 (analytics) → Agency $99 (workspaces).
