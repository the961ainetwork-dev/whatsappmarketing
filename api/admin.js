import { sb, readBody, cors } from './_lib.js';

function checkAdmin(req) {
  const pass = req.headers?.['x-admin-pass'] || '';
  return pass && pass === (process.env.WM_ADMIN_PASS || 'wamark-admin-2026');
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Pass');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Admin password required' });

  try {
    if (req.method === 'GET') {
      // ── User detail (supervision view) ──
      if (req.query?.userId) {
        const uid = Number(req.query.userId);
        const [ur, cr, mr, pr, sr, dr] = await Promise.all([
          sb(`wm_users?id=eq.${uid}&select=id,email,plan,status,created_at,last_seen,demo_expires`),
          sb(`wm_contacts?user_id=eq.${uid}&select=*&order=id.desc&limit=50`),
          sb(`wm_messages?user_id=eq.${uid}&select=*&order=id.desc&limit=50`),
          sb(`wm_campaigns?user_id=eq.${uid}&select=*&order=id.desc&limit=20`),
          sb(`wm_settings?user_id=eq.${uid}&select=business_name,phone_number_id,ai_enabled,ai_prompt`),
          sb(`wm_drips?user_id=eq.${uid}&select=*`),
        ]);
        const [user] = ur.ok ? await ur.json() : [];
        return res.status(200).json({
          user,
          contacts: cr.ok ? await cr.json() : [],
          messages: mr.ok ? await mr.json() : [],
          campaigns: pr.ok ? await pr.json() : [],
          settings: (sr.ok ? await sr.json() : [])[0] || {},
          drips: dr.ok ? await dr.json() : [],
        });
      }

      // ── Overview: all users + stats + activity feed ──
      const [ur, cr, mr, pr, er] = await Promise.all([
        sb(`wm_users?select=id,email,plan,status,created_at,last_seen,demo_expires&order=id.desc&limit=500`),
        sb(`wm_contacts?select=user_id`),
        sb(`wm_messages?select=user_id`),
        sb(`wm_campaigns?select=user_id,sent`),
        sb(`wm_events?select=*&order=id.desc&limit=150`),
      ]);
      const users = ur.ok ? await ur.json() : [];
      const contacts = cr.ok ? await cr.json() : [];
      const messages = mr.ok ? await mr.json() : [];
      const campaigns = pr.ok ? await pr.json() : [];
      const events = er.ok ? await er.json() : [];

      const count = (arr, uid) => arr.filter(x => x.user_id === uid).length;
      const enriched = users.map(u => ({
        ...u,
        contacts: count(contacts, u.id),
        messages: count(messages, u.id),
        campaigns: count(campaigns, u.id),
        sent: campaigns.filter(c => c.user_id === u.id).reduce((s, c) => s + (c.sent || 0), 0),
      }));

      return res.status(200).json({
        users: enriched,
        events,
        totals: {
          users: users.length,
          pending: users.filter(u => u.status === 'pending').length,
          active: users.filter(u => u.status === 'active').length,
          demos: users.filter(u => u.status === 'demo').length,
          contacts: contacts.length,
          messages: messages.length,
        },
      });
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const uid = Number(b.userId);
      if (!uid) return res.status(400).json({ error: 'userId required' });

      if (b.action === 'status') {
        const status = ['pending', 'active', 'suspended', 'rejected'].includes(b.status) ? b.status : null;
        if (!status) return res.status(400).json({ error: 'Bad status' });
        await sb(`wm_users?id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'plan') {
        const plan = ['free', 'demo', 'starter', 'pro', 'agency'].includes(b.plan) ? b.plan : null;
        if (!plan) return res.status(400).json({ error: 'Bad plan' });
        await sb(`wm_users?id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ plan }) });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const uid = Number(req.query?.userId);
      if (!uid) return res.status(400).json({ error: 'userId required' });
      await sb(`wm_users?id=eq.${uid}`, { method: 'DELETE' }); // cascades
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
