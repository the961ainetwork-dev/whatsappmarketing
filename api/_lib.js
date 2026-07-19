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

// ── WhatsApp Cloud API send ──
export async function waSend(settings, to, payload) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${settings.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, id: d.messages?.[0]?.id, error: d.error?.message };
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
