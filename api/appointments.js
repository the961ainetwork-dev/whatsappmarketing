import { sb, authUser, readBody, cors } from './_lib.js';

// Generate open slots from a business's booking config, minus booked ones
export async function openSlots(userId, cfg) {
  const days = cfg.days || [1, 2, 3, 4, 5];
  const startH = cfg.start ?? 9, endH = cfg.end ?? 17, step = cfg.step || 30, weeks = cfg.weeks || 2;
  const gen = [];
  const now = new Date();
  for (let d = 0; d < weeks * 7; d++) {
    const day = new Date(now); day.setDate(now.getDate() + d);
    if (!days.includes(day.getDay())) continue;
    for (let hh = startH; hh < endH; hh++) for (let mm = 0; mm < 60; mm += step) {
      const s = new Date(day); s.setHours(hh, mm, 0, 0);
      if (s > now) gen.push(s.toISOString());
    }
  }
  const br = await sb(`wm_appointments?user_id=eq.${userId}&status=eq.booked&slot_at=gte.${now.toISOString()}&select=slot_at`);
  const booked = new Set((br.ok ? await br.json() : []).map(x => new Date(x.slot_at).toISOString()));
  return gen.filter(iso => !booked.has(iso));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const [ar, sr] = await Promise.all([
        sb(`wm_appointments?user_id=eq.${user.id}&select=*&order=slot_at.asc&limit=200`),
        sb(`wm_settings?user_id=eq.${user.id}&select=booking_config,booking_enabled`),
      ]);
      const settings = (sr.ok ? await sr.json() : [])[0] || {};
      let cfg = {};
      try { cfg = settings.booking_config ? JSON.parse(settings.booking_config) : {}; } catch {}
      return res.status(200).json({ appointments: ar.ok ? await ar.json() : [], config: cfg, enabled: !!settings.booking_enabled });
    }

    if (req.method === 'PUT') {
      // save booking config
      const b = readBody(req);
      const cfg = {
        days: Array.isArray(b.days) ? b.days.map(Number) : [1, 2, 3, 4, 5],
        start: Number(b.start ?? 9), end: Number(b.end ?? 17),
        step: Number(b.step || 30), weeks: Number(b.weeks || 2),
        service: String(b.service || 'Appointment').slice(0, 80),
      };
      const patch = { booking_config: JSON.stringify(cfg) };
      if ('enabled' in b) patch.booking_enabled = !!b.enabled;
      const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Save failed' });
    }

    if (req.method === 'POST') {
      // manual booking from dashboard
      const b = readBody(req);
      if (!b.slot_at) return res.status(400).json({ error: 'slot_at required' });
      const row = {
        user_id: user.id, phone: String(b.phone || '').replace(/\D/g, ''),
        customer_name: String(b.customer_name || '').slice(0, 120),
        slot_at: new Date(b.slot_at).toISOString(),
        service: String(b.service || '').slice(0, 80), note: String(b.note || '').slice(0, 300),
      };
      const r = await sb('wm_appointments', { method: 'POST', body: JSON.stringify([row]) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Book failed' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_appointments?id=eq.${id}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
