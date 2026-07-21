import crypto from 'crypto';

export const SUPABASE_URL = process.env.WM_SUPABASE_URL || 'https://ldlzpnuvkudmvpvnbomc.supabase.co';

export function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

export function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}
export function newSalt() { return crypto.randomBytes(16).toString('hex'); }
export function newToken() { return crypto.randomBytes(24).toString('hex'); }

export async function authUser(req) {
  const h = req.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const r = await sb(`wm_users?token=eq.${encodeURIComponent(token)}&select=id,email,plan,status,demo_expires`);
  const rows = r.ok ? await r.json() : [];
  const u = rows[0];
  if (!u) return null;
  if (u.status === 'rejected' || u.status === 'suspended') return null;
  if (u.status === 'demo' && u.demo_expires && new Date(u.demo_expires) < new Date()) return null;
  sb(`wm_users?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ last_seen: new Date().toISOString() }) }).catch(() => {});
  return u;
}

export function isLimited(u) { return u.status === 'demo' || u.status === 'pending'; }
export const DEMO_CONTACT_CAP = 25;

export function logEvent(userId, email, event, meta) {
  sb('wm_events', { method: 'POST', body: JSON.stringify([{ user_id: userId || null, email: email || null, event, meta: meta ? String(meta).slice(0, 500) : null }]) }).catch(() => {});
}

export function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  return b || {};
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Provider-aware WhatsApp send (Meta Cloud API OR Twilio) ──
export async function waSend(settings, to, payload) {
  if (settings.provider === 'twilio') return twilioSend(settings, to, payload);
  // default: Meta Cloud API
  const r = await fetch(`https://graph.facebook.com/v21.0/${settings.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, id: d.messages?.[0]?.id, error: d.error?.message };
}

// Twilio WhatsApp sender — converts our payload to Twilio's form-encoded API
async function twilioSend(settings, to, payload) {
  const sid = settings.twilio_sid, tok = settings.twilio_token, from = settings.twilio_from;
  if (!sid || !tok || !from) return { ok: false, error: 'Twilio credentials missing' };
  // Flatten our Meta-style payload to a plain body string
  let body = '';
  if (payload.type === 'text') body = payload.text?.body || '';
  else if (payload.type === 'template') {
    // Twilio has no free-form templates here; send the vars joined (best-effort for MVP)
    const vars = payload.template?.components?.[0]?.parameters?.map(p => p.text) || [];
    body = vars.length ? vars.join(' ') : `[template:${payload.template?.name}]`;
  }
  const toAddr = to.startsWith('whatsapp:') ? to : `whatsapp:+${String(to).replace(/\D/g, '')}`;
  const fromAddr = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
  const form = new URLSearchParams({ To: toAddr, From: fromAddr, Body: body });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, id: d.sid, error: d.message };
}

export function waText(body) { return { type: 'text', text: { body } }; }
export function waTemplate(name, lang, vars = []) {
  return {
    type: 'template',
    template: {
      name, language: { code: lang || 'en' },
      components: vars.length ? [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: String(v) })) }] : [],
    },
  };
}

export async function getSettings(userId) {
  const r = await sb(`wm_settings?user_id=eq.${userId}&select=*`);
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}

export async function logMsg(userId, phone, direction, body, kind, waId, campaignId) {
  await sb('wm_messages', { method: 'POST', body: JSON.stringify([{ user_id: userId, phone, direction, body: String(body || '').slice(0, 4000), kind, wa_id: waId || null, campaign_id: campaignId || null, status: direction === 'out' ? 'sent' : null }]) });
}

// ── Anti-ban warm-up: daily send caps by account sending age ──
export function warmupCap(firstSendAt) {
  if (!firstSendAt) return 50;
  const days = Math.floor((Date.now() - new Date(firstSendAt)) / 86400000) + 1;
  if (days <= 3) return 50;
  if (days <= 7) return 200;
  if (days <= 14) return 500;
  return 1000;
}

export async function sentToday(userId) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const r = await sb(`wm_messages?user_id=eq.${userId}&direction=eq.out&created_at=gte.${midnight.toISOString()}&select=id`);
  return r.ok ? (await r.json()).length : 0;
}


// ── Region detection from WhatsApp number (country code → country/lang/tz offset) ──
const DIAL = [
  ['961','Lebanon','Levantine Arabic',2],['962','Jordan','Levantine Arabic',2],['963','Syria','Levantine Arabic',2],
  ['971','UAE','Gulf Arabic',4],['966','Saudi Arabia','Gulf Arabic',3],['965','Kuwait','Gulf Arabic',3],
  ['974','Qatar','Gulf Arabic',3],['973','Bahrain','Gulf Arabic',3],['968','Oman','Gulf Arabic',4],
  ['20','Egypt','Egyptian Arabic',2],['212','Morocco','Darija Arabic',1],['213','Algeria','Arabic',1],
  ['216','Tunisia','Arabic',1],['964','Iraq','Iraqi Arabic',3],['967','Yemen','Arabic',3],
  ['970','Palestine','Levantine Arabic',2],['1','USA/Canada','English',-5],['44','UK','English',0],
  ['33','France','French',1],['49','Germany','German',1],['90','Turkey','Turkish',3],['91','India','English',5],
];
export function regionFromPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  let best = null;
  for (const [code, country, lang, tz] of DIAL) {
    if (p.startsWith(code) && (!best || code.length > best[0].length)) best = [code, country, lang, tz];
  }
  if (!best) return { country: 'Unknown', language: 'Arabic/English', local_time: '' };
  const [, country, language, tz] = best;
  const now = new Date();
  const local = new Date(now.getTime() + (tz * 60 + now.getTimezoneOffset()) * 60000);
  const local_time = local.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return { country, language, local_time };
}


// Build a compact catalog string for the AI responder (Catalog Agent)
export async function catalogContext(userId) {
  const r = await sb(`wm_products?user_id=eq.${userId}&in_stock=eq.true&select=name,price,currency,category,description&order=category.asc&limit=200`);
  if (!r.ok) return '';
  const items = await r.json();
  if (!items.length) return '';
  const lines = items.map(p => {
    const price = p.price != null ? `${p.price} ${p.currency || 'USD'}` : 'ask for price';
    return `- ${p.name}${p.category ? ' [' + p.category + ']' : ''}: ${price}${p.description ? ' — ' + p.description : ''}`;
  });
  return `\n\nPRODUCT CATALOG (use this to answer product/price questions; recommend items, mention prices, suggest options within the customer's budget):\n${lines.join('\n')}`;
}


// Booking context for the AI: next available slots (Appointment Agent)
export async function bookingContext(userId, settings) {
  if (!settings.booking_enabled) return '';
  let cfg = {};
  try { cfg = settings.booking_config ? JSON.parse(settings.booking_config) : {}; } catch {}
  const { openSlots } = await import('./appointments.js');
  const slots = await openSlots(userId, cfg);
  if (!slots.length) return '';
  // show next 8 options compactly
  const opts = slots.slice(0, 8).map(iso => {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  });
  return `\n\nAPPOINTMENT BOOKING is available for "${cfg.service || 'appointments'}". If the customer wants to book, offer these next open times and confirm one, then tell them it's reserved:\n${opts.join('\n')}\nWhen the customer picks a time, in your ###LEAD### JSON also add "book_slot":"<the ISO or exact time they chose>".`;
}
