import { sb, authUser, cors } from './_lib.js';

const ALLOWED = ['pro', 'agency'];

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (!ALLOWED.includes(user.plan)) return res.status(402).json({ error: 'upgrade', message: 'Campaign Analytics is a Pro feature — upgrade to unlock delivery, read and reply rates.' });

  try {
    const cid = Number(req.query?.campaignId);
    if (!cid) return res.status(400).json({ error: 'campaignId required' });
    const cr = await sb(`wm_campaigns?id=eq.${cid}&user_id=eq.${user.id}&select=*`);
    const [camp] = cr.ok ? await cr.json() : [];
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });

    const mr = await sb(`wm_messages?campaign_id=eq.${cid}&user_id=eq.${user.id}&select=phone,status,created_at`);
    const msgs = mr.ok ? await mr.json() : [];
    const total = msgs.length;
    const delivered = msgs.filter(m => ['delivered', 'read'].includes(m.status)).length;
    const read = msgs.filter(m => m.status === 'read').length;
    const failed = msgs.filter(m => m.status === 'failed').length;

    // replies: inbound from targeted phones after campaign creation
    const phones = [...new Set(msgs.map(m => m.phone))];
    let replies = 0;
    if (phones.length) {
      const chunk = phones.slice(0, 200).map(p => `"${p}"`).join(',');
      const rr = await sb(`wm_messages?user_id=eq.${user.id}&direction=eq.in&created_at=gte.${camp.created_at}&phone=in.(${chunk})&select=phone`);
      replies = rr.ok ? new Set((await rr.json()).map(x => x.phone)).size : 0;
    }
    const pct = n => total ? Math.round((n / total) * 100) : 0;
    return res.status(200).json({
      ok: true, campaign: camp.name, total,
      delivered, read, failed, replies,
      rates: { delivered: pct(delivered), read: pct(read), failed: pct(failed), replied: pct(replies) },
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
