import { sb, authUser, readBody, cors, isLimited, DEMO_CONTACT_CAP, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const cat = req.query?.category;
      let q = '';
      if (cat?.startsWith('seg:')) {
        const d7 = new Date(Date.now() - 7 * 86400000).toISOString();
        q = { 'seg:hot': '&intent=eq.hot', 'seg:warm': '&intent=eq.warm', 'seg:replied7d': `&last_inbound=gte.${d7}`, 'seg:never': '&last_inbound=is.null', 'seg:new7d': `&created_at=gte.${d7}` }[cat] || '';
      } else if (cat && cat !== 'all') q = `&category=eq.${encodeURIComponent(cat)}`;
      const r = await sb(`wm_contacts?user_id=eq.${user.id}${q}&select=*&order=id.desc&limit=1000`);
      const items = r.ok ? await r.json() : [];
      const cr = await sb(`wm_contacts?user_id=eq.${user.id}&select=category`);
      const cats = [...new Set(((cr.ok ? await cr.json() : [])).map(x => x.category).filter(Boolean))];
      return res.status(200).json({ items, categories: cats });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      if (b.action === 'import') {
        if (isLimited(user)) {
          const cr0 = await sb(`wm_contacts?user_id=eq.${user.id}&select=id`);
          const have = cr0.ok ? (await cr0.json()).length : 0;
          if (have >= DEMO_CONTACT_CAP) return res.status(400).json({ error: `Demo/pending accounts are capped at ${DEMO_CONTACT_CAP} contacts — upgrade to unlock` });
        }
        // rows: [{phone,name,category}]
        const rows = (b.rows || []).slice(0, 2000)
          .map(r => ({ user_id: user.id, phone: String(r.phone || '').replace(/\D/g, ''), name: String(r.name || '').slice(0, 120), category: String(r.category || b.category || 'general').slice(0, 60) || 'general', source: 'csv' }))
          .filter(r => r.phone.length >= 8);
        if (!rows.length) return res.status(400).json({ error: 'No valid rows (need phone with country code)' });
        const r = await sb('wm_contacts?on_conflict=user_id,phone', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
        if (!r.ok) return res.status(500).json({ error: 'Import failed: ' + (await r.text()).slice(0, 150) });
        logEvent(user.id, user.email, 'contacts_import', `${rows.length} rows`);
        return res.status(200).json({ ok: true, imported: rows.length });
      }
      const phone = String(b.phone || '').replace(/\D/g, '');
      if (phone.length < 8) return res.status(400).json({ error: 'Phone with country code required' });
      const row = { user_id: user.id, phone, name: String(b.name || '').slice(0, 120), category: String(b.category || 'general').slice(0, 60) };
      const r = await sb('wm_contacts?on_conflict=user_id,phone', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([row]) });
      if (!r.ok) return res.status(500).json({ error: 'Add failed' });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'PUT') {
      const b = readBody(req);
      const patch = {};
      for (const k of ['name', 'category', 'interest']) if (k in b) patch[k] = String(b[k] || '').slice(0, 200);
      if ('opt_in' in b) patch.opt_in = !!b.opt_in;
      const r = await sb(`wm_contacts?id=eq.${Number(b.id)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Update failed' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      const r = await sb(`wm_contacts?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(r.ok ? 200 : 500).json(r.ok ? { ok: true } : { error: 'Delete failed' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
