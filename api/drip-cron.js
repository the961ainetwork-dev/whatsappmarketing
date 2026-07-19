import { sb, waSend, waText, waTemplate, getSettings, logMsg } from './_lib.js';
import { processCampaign } from './campaigns.js';

export default async function handler(req, res) {
  const report = { drips: 0, campaigns: 0 };
  try {
    // ── 1. Due drip steps (max 40 per run) ──
    const now = new Date().toISOString();
    const dr = await sb(`wm_drip_state?done=eq.false&next_at=lte.${now}&select=*&order=next_at.asc&limit=40`);
    const due = dr.ok ? await dr.json() : [];
    const settingsCache = {};

    for (const st of due) {
      try {
        const drp = await sb(`wm_drips?id=eq.${st.drip_id}&select=*`);
        const [drip] = drp.ok ? await drp.json() : [];
        if (!drip || !drip.active) { await sb(`wm_drip_state?id=eq.${st.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }); continue; }

        const sr = await sb(`wm_drip_steps?drip_id=eq.${st.drip_id}&select=*&order=day_offset.asc`);
        const steps = sr.ok ? await sr.json() : [];
        const step = steps[st.step_index];
        if (!step) { await sb(`wm_drip_state?id=eq.${st.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }); continue; }

        const cr = await sb(`wm_contacts?id=eq.${st.contact_id}&select=*`);
        const [ct] = cr.ok ? await cr.json() : [];
        if (!ct || !ct.opt_in) { await sb(`wm_drip_state?id=eq.${st.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) }); continue; }

        if (!settingsCache[st.user_id]) settingsCache[st.user_id] = await getSettings(st.user_id);
        const settings = settingsCache[st.user_id];
        if (!settings?.access_token) continue;

        const varVal = step.var1_field === 'name' ? (ct.name || 'there') : (ct[step.var1_field] || '');
        const payload = step.mode === 'template'
          ? waTemplate(step.template_name, step.lang, [varVal])
          : waText((step.body || '').replaceAll('{{1}}', varVal));
        const out = await waSend(settings, ct.phone, payload);
        if (out.ok) { report.drips++; await logMsg(st.user_id, ct.phone, 'out', step.mode === 'template' ? `[drip:${step.template_name}]` : step.body, 'drip', out.id); }

        // advance
        const next = steps[st.step_index + 1];
        if (next) {
          const base = new Date(st.next_at).getTime();
          const nextAt = new Date(base + (next.day_offset - step.day_offset) * 86400000).toISOString();
          await sb(`wm_drip_state?id=eq.${st.id}`, { method: 'PATCH', body: JSON.stringify({ step_index: st.step_index + 1, next_at: nextAt }) });
        } else {
          await sb(`wm_drip_state?id=eq.${st.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
        }
        await new Promise(s => setTimeout(s, 200));
      } catch { /* skip bad row */ }
    }

    // ── 2. Scheduled campaigns whose time arrived + resume "sending" ones ──
    const cq = await sb(`wm_campaigns?or=(and(status.eq.scheduled,scheduled_at.lte.${now}),status.eq.sending)&select=*&order=id.asc&limit=5`);
    const camps = cq.ok ? await cq.json() : [];
    for (const c of camps) {
      if (c.status === 'scheduled') await sb(`wm_campaigns?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'sending' }) });
      if (!settingsCache[c.user_id]) settingsCache[c.user_id] = await getSettings(c.user_id);
      const settings = settingsCache[c.user_id];
      if (!settings?.access_token) continue;
      const out = await processCampaign(c, settings);
      report.campaigns += out.sent;
    }

    return res.status(200).json({ ok: true, ...report });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, ...report });
  }
}
