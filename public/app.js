const $ = id => document.getElementById(id);
let offset = 0, o = null, qrFor = null, poll = null, tick = null;
const show = id => ['start', 'pay', 'done', 'exp'].forEach(s => $(s).hidden = s !== id);
const fmt = s => { s = Math.max(0, s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

$('f').addEventListener('submit', async e => {
  e.preventDefault(); $('go').disabled = true; $('err').textContent = '';
  try {
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd: $('usd').value.trim() }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    location.hash = j.ref; load();
  } catch (x) { $('err').textContent = x.message; $('go').disabled = false; }
});

async function load() {
  const ref = location.hash.slice(1); if (!ref) return show('start');
  clearInterval(poll); clearInterval(tick);
  const get = async () => {
    try {
      const r = await fetch('/api/order/' + encodeURIComponent(ref));
      if (!r.ok) { clearInterval(poll); return show('start'); }
      o = await r.json(); offset = o.serverNow - Math.floor(Date.now() / 1000); render();
    } catch { $('status').textContent = 'Connection problem, retrying...'; }
  };
  await get(); poll = setInterval(get, 3000); tick = setInterval(count, 1000);
}

function count() { if (o && o.status === 'pending') $('cd').textContent = fmt(o.expiresAt - (Math.floor(Date.now() / 1000) + offset)); }

function render() {
  if (o.status === 'paid') {
    clearInterval(poll); clearInterval(tick); show('done');
    $('doneTxt').textContent = `Order ${o.ref}: $${o.usd} received${o.late ? ' (after the invoice expired)' : ''}. Thank you.`; return;
  }
  if (o.status === 'expired') { clearInterval(poll); clearInterval(tick); return show('exp'); }
  show('pay');
  $('ref').textContent = 'Order ' + o.ref; $('usdOut').textContent = '$' + o.usd;
  $('btc').textContent = o.btc + ' BTC'; $('sats').textContent = Number(o.sats).toLocaleString();
  $('rate').textContent = '$' + o.rate + ' at ' + new Date(o.rateAt * 1000).toLocaleTimeString();
  if (o.cashAppLink) $('cash').href = o.cashAppLink; else $('cash').hidden = true;
  if (qrFor !== o.ref) {
    qrFor = o.ref; $('qr').textContent = '';
    new QRCode($('qr'), { text: 'lightning:' + o.bolt11, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.L });
  }
  count();
}

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(o.bolt11); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Copy failed - select the QR instead'; }
  setTimeout(() => $('copy').textContent = 'Copy Lightning invoice', 2000);
});
window.addEventListener('hashchange', load); load();
