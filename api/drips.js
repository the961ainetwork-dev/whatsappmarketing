import { sb, authUser, readBody, cors, logEvent } from './_lib.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  try {
    if (req.method === 'GET') {
      const dr = await sb(`wm_drips?user_id=eq.${user.id}&select=*&order=id.desc`);
      const drips = dr.ok ? await dr.json() : [];
      const ids = drips.map(d => d.id);
      let steps = [];
      if (ids.length) {
        const sr = await sb(`wm_drip_steps?drip_id=in.(${ids.join(',')})&select=*&order=day_offset.asc`);
        steps = sr.ok ? await sr.json() : [];
      }
      // enrollment counts
      let counts = {};
      if (ids.length) {
        const cr = await sb(`wm_drip_state?drip_id=in.(${ids.join(',')})&select=drip_id,done`);
        for (const row of (cr.ok ? await cr.json() : [])) {
          counts[row.drip_id] = counts[row.drip_id] || { active: 0, done: 0 };
          counts[row.drip_id][row.done ? 'done' : 'active']++;
        }
      }
      return res.status(200).json({ drips: drips.map(d => ({ ...d, steps: steps.filter(s => s.drip_id === d.id), stats: counts[d.id] || { active: 0, done: 0 } })) });
    }

    if (req.method === 'POST') {
      const b = readBody(req);

      if (b.action === 'create') {
        const row = { user_id: user.id, name: String(b.name || 'Sequence').slice(0, 120), category: String(b.category || 'all').slice(0, 60), active: true };
        const r = await sb('wm_drips', { method: 'POST', body: JSON.stringify([row]) });
        if (!r.ok) return res.status(500).json({ error: 'Create failed' });
        const [d] = await r.json();
        const steps = (b.steps || []).slice(0, 10).map(s => ({
          drip_id: d.id, day_offset: Math.max(0, parseInt(s.day_offset) || 0),
          mode: s.mode === 'text' ? 'text' : 'template',
          template_name: String(s.template_name || '').slice(0, 120),
          lang: String(s.lang || 'en').slice(0, 10),
          body: String(s.body || '').slice(0, 2000),
          var1_field: ['name', 'interest', 'phone'].includes(s.var1_field) ? s.var1_field : 'name',
        }));
        if (steps.length) await sb('wm_drip_steps', { method: 'POST', body: JSON.stringify(steps) });
        logEvent(user.id, user.email, 'drip_create', row.name);
        return res.status(200).json({ ok: true, id: d.id });
      }

      if (b.action === 'enroll') {
        // enroll all contacts of the drip's category who aren't enrolled yet
        const dr = await sb(`wm_drips?id=eq.${Number(b.dripId)}&user_id=eq.${user.id}&select=*`);
        const [d] = dr.ok ? await dr.json() : [];
        if (!d) return res.status(404).json({ error: 'Drip not found' });
        const sr = await sb(`wm_drip_steps?drip_id=eq.${d.id}&select=day_offset&order=day_offset.asc&limit=1`);
        const [first] = sr.ok ? await sr.json() : [];
        if (!first) return res.status(400).json({ error: 'Add at least one step first' });
        const catQ = d.category && d.category !== 'all' ? `&category=eq.${encodeURIComponent(d.category)}` : '';
        const cr = await sb(`wm_contacts?user_id=eq.${user.id}${catQ}&opt_in=eq.true&select=id`);
        const contacts = cr.ok ? await cr.json() : [];
        if (!contacts.length) return res.status(400).json({ error: 'No contacts in this category' });
        const nextAt = new Date(Date.now() + first.day_offset * 86400000).toISOString();
        const rows = contacts.map(c => ({ user_id: user.id, drip_id: d.id, contact_id: c.id, step_index: 0, next_at: nextAt }));
        const ir = await sb('wm_drip_state?on_conflict=drip_id,contact_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(rows) });
        const added = ir.ok ? (await ir.json()).length : 0;
        logEvent(user.id, user.email, 'drip_enroll', `drip ${d.id}: ${added}`);
        return res.status(200).json({ ok: true, enrolled: added, skipped: contacts.length - added });
      }

      if (b.action === 'toggle') {
        await sb(`wm_drips?id=eq.${Number(b.dripId)}&user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ active: !!b.active }) });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const id = Number(req.query?.id);
      await sb(`wm_drips?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
