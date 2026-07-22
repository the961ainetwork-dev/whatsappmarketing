import { sb, authUser, readBody, cors } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const [ir, sr] = await Promise.all([
        sb(`wm_invoices?user_id=eq.${user.id}&select=*&order=due_at.asc&limit=300`),
        sb(`wm_settings?user_id=eq.${user.id}&select=invoice_enabled,invoice_config`),
      ]);
      const s = (sr.ok ? await sr.json() : [])[0] || {};
      let cfg = {}; try { cfg = s.invoice_config ? JSON.parse(s.invoice_config) : {}; } catch {}
      return res.status(200).json({ invoices: ir.ok ? await ir.json() : [], enabled: !!s.invoice_enabled, config: cfg });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      if (!b.phone || !b.amount) return res.status(400).json({ error: 'Customer number and amount are required' });
      const row = {
        user_id: user.id,
        phone: String(b.phone).replace(/\D/g, ''),
        customer_name: String(b.customer_name || '').slice(0, 120),
        reference: String(b.reference || '').slice(0, 60),
        amount: Number(String(b.amount).replace(/[^0-9.]/g, '')) || 0,
        currency: String(b.currency || 'USD').slice(0, 8),
        due_at: b.due_at || null,
        note: String(b.note || '').slice(0, 300),
      };
      const r = await sb('wm_invoices', { method: 'POST', body: JSON.stringify([row]) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not save the invoice' });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      if (b.action === 'config') {
        const cfg = { before: Number(b.before ?? 3), after: Array.isArray(b.after) ? b.after.map(Number) : [1, 7, 14] };
        const patch = { invoice_config: JSON.stringify(cfg) };
        if ('enabled' in b) patch.invoice_enabled = !!b.enabled;
        const r = await sb(`wm_settings?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not save settings' });
      }
      const patch = {};
      if (b.status && ['unpaid', 'paid', 'cancelled'].includes(b.status)) patch.status = b.status;
      if ('amount' in b) patch.amount = Number(String(b.amount).replace(/[^0-9.]/g, '')) || 0;
      if ('due_at' in b) patch.due_at = b.due_at || null;
      const r = await sb(`wm_invoices?id=eq.${Number(b.id)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Could not update the invoice' });
    }

    if (req.method === 'DELETE') {
      await sb(`wm_invoices?id=eq.${Number(req.query?.id)}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
