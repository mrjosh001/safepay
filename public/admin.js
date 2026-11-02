const $ = id => document.getElementById(id);
const api = async (path, opts = {}) => {
  const r = await fetch('/api/admin' + path, { ...opts, headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; throw e; } return j;
};
const enter = () => { $('login').hidden = true; $('panel').hidden = false; refresh(); };

$('in').addEventListener('click', async () => {
  $('lerr').textContent = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) }); enter(); }
  catch (e) { $('lerr').textContent = e.message; }
});

$('mk').addEventListener('click', async () => {
  $('merr').textContent = ''; $('out').hidden = true; $('mk').disabled = true;
  try {
    const j = await api('/links', { method: 'POST', body: JSON.stringify({ usd: $('usd').value.trim(), bolt11: $('inv').value, note: $('note').value }) });
    $('lnk').textContent = j.link; $('out').hidden = false; $('inv').value = ''; $('usd').value = ''; $('note').value = ''; refresh();
  } catch (e) { $('merr').textContent = e.message; }
  $('mk').disabled = false;
});

$('cp').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('lnk').textContent); $('cp').textContent = 'Copied'; } catch { $('cp').textContent = 'Select and copy manually'; }
  setTimeout(() => $('cp').textContent = 'Copy link', 2000);
});

async function refresh() {
  try {
    const rows = await api('/links'); const box = $('list'); box.textContent = '';
    if (!rows.length) { box.textContent = 'No links yet.'; return; }
    for (const r of rows) {
      const d = document.createElement('div'); d.className = 'item';
      const t = document.createElement('div');
      t.textContent = `$${(r.usd_cents / 100).toFixed(2)} · ${Number(r.sats).toLocaleString()} sats · ${r.status}${r.late ? ' (late)' : ''}${r.note ? ' · ' + r.note : ''}`;
      d.append(t);
      const c = document.createElement('button'); c.className = 'alt'; c.textContent = 'Copy link';
      c.onclick = async () => { await navigator.clipboard.writeText(location.origin + '/#' + r.ref).catch(() => {}); c.textContent = 'Copied'; };
      d.append(c);
      if (r.status !== 'paid') {
        const p = document.createElement('button'); p.className = 'alt'; p.textContent = 'Mark paid';
        p.onclick = async () => { if (confirm('Did this payment arrive in your wallet?')) { await api('/links/' + encodeURIComponent(r.ref) + '/paid', { method: 'POST', body: '{}' }); refresh(); } };
        d.append(p);
      }
      box.append(d);
    }
  } catch (e) { if (e.status === 401) { $('login').hidden = false; $('panel').hidden = true; } }
}
refresh();
