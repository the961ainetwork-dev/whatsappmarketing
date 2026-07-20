import { sb, readBody, cors } from './_lib.js';

function isAdmin(req) {
  const p = req.headers?.['x-admin-pass'] || '';
  return p && p === (process.env.WM_ADMIN_PASS || 'wamark-admin-2026');
}

// Weekly availability config
const DAYS = [1, 2, 3, 4, 5];      // Mon-Fri (0=Sun)
const START_H = 10, END_H = 16;    // 10:00 → 16:00
const STEP_MIN = 30;               // 30-min slots
const WEEKS_AHEAD = 3;             // generate 3 weeks of bookable slots

// Build the list of valid future slot ISO strings from config
function generateSlots() {
  const out = [];
  const now = new Date();
  for (let d = 0; d < WEEKS_AHEAD * 7; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() + d);
    if (!DAYS.includes(day.getDay())) continue;
    for (let h = START_H; h < END_H; h++) {
      for (let m = 0; m < 60; m += STEP_MIN) {
        const s = new Date(day);
        s.setHours(h, m, 0, 0);
        if (s > now) out.push(s.toISOString());
      }
    }
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Pass');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Public: list bookable slots (config-generated minus already-booked) ──
    if (req.method === 'GET' && !isAdmin(req)) {
      const now = new Date().toISOString();
      const br = await sb(`wm_demo_slots?booked=eq.true&slot_at=gte.${now}&select=slot_at`);
      const booked = new Set((br.ok ? await br.json() : []).map(x => new Date(x.slot_at).toISOString()));
      const slots = generateSlots().filter(iso => !booked.has(iso)).map(iso => ({ slot_at: iso }));
      return res.status(200).json({ slots, config: { start: START_H, end: END_H, step: STEP_MIN, days: DAYS } });
    }

    // ── Public: book a slot ──
    if (req.method === 'POST' && !req.headers?.['x-admin-pass']) {
      const b = readBody(req);
      const iso = b.slot_at ? new Date(b.slot_at).toISOString() : null;
      if (!iso || !b.name || !b.email) return res.status(400).json({ error: 'Name, email and a time are required' });
      // validate it's a real generated slot and still future
      if (new Date(iso) < new Date()) return res.status(400).json({ error: 'That time has passed — pick another' });
      // check not already taken
      const cr = await sb(`wm_demo_slots?slot_at=eq.${encodeURIComponent(iso)}&booked=eq.true&select=id`);
      if (cr.ok && (await cr.json()).length) return res.status(409).json({ error: 'That slot was just taken — pick another' });
      // insert as booked
      const r = await sb('wm_demo_slots?on_conflict=slot_at', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{ slot_at: iso, booked: true, name: String(b.name).slice(0, 120), email: String(b.email).slice(0, 160), phone: String(b.phone || '').slice(0, 40), note: String(b.note || '').slice(0, 500) }]),
      });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Booking failed' });
    }

    // ── Admin: view all bookings ──
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
    if (req.method === 'GET') {
      const now = new Date().toISOString();
      const r = await sb(`wm_demo_slots?booked=eq.true&slot_at=gte.${now}&select=*&order=slot_at.asc`);
      return res.status(200).json({ bookings: r.ok ? await r.json() : [], config: { start: START_H, end: END_H, step: STEP_MIN, days: DAYS } });
    }
    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_demo_slots?id=eq.${id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
