import { sb, readBody, cors } from './_lib.js';

function isAdmin(req) {
  const p = req.headers?.['x-admin-pass'] || '';
  return p && p === (process.env.WM_ADMIN_PASS || 'wamark-admin-2026');
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Pass');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Public: list open future slots ──
    if (req.method === 'GET' && !isAdmin(req)) {
      const now = new Date().toISOString();
      const r = await sb(`wm_demo_slots?booked=eq.false&slot_at=gte.${now}&select=id,slot_at&order=slot_at.asc&limit=60`);
      return res.status(200).json({ slots: r.ok ? await r.json() : [] });
    }

    // ── Public: book a slot ──
    if (req.method === 'POST' && !req.headers?.['x-admin-pass']) {
      const b = readBody(req);
      const id = Number(b.id);
      if (!id || !b.name || !b.email) return res.status(400).json({ error: 'Name, email and a slot are required' });
      // ensure still open
      const cr = await sb(`wm_demo_slots?id=eq.${id}&booked=eq.false&select=id`);
      if (!(cr.ok && (await cr.json()).length)) return res.status(409).json({ error: 'That slot was just taken — pick another' });
      const r = await sb(`wm_demo_slots?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ booked: true, name: String(b.name).slice(0, 120), email: String(b.email).slice(0, 160), phone: String(b.phone || '').slice(0, 40), note: String(b.note || '').slice(0, 500) }) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Booking failed' });
    }

    // ── Admin below ──
    if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });

    if (req.method === 'GET') {
      const r = await sb(`wm_demo_slots?select=*&order=slot_at.asc&limit=200`);
      return res.status(200).json({ slots: r.ok ? await r.json() : [] });
    }
    if (req.method === 'POST') {
      const b = readBody(req);
      if (b.action === 'add') {
        // add one or many slots: b.slots = [ISO strings]
        const list = (Array.isArray(b.slots) ? b.slots : [b.slot]).filter(Boolean).slice(0, 100)
          .map(s => ({ slot_at: new Date(s).toISOString() }));
        if (!list.length) return res.status(400).json({ error: 'No slots provided' });
        const r = await sb('wm_demo_slots?on_conflict=slot_at', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(list) });
        return res.status(200).json({ ok: true, added: r.ok ? (await r.json()).length : 0 });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_demo_slots?id=eq.${id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
