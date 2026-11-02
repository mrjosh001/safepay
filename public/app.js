const $ = id => document.getElementById(id);
let offset = 0, o = null, qrFor = null, poll = null, tick = null, picked = '';
const show = id => ['start', 'pay', 'done', 'exp'].forEach(s => $(s).hidden = s !== id);
const fmt = s => { s = Math.max(0, s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

function addAmounts(box, list) {
  for (const n of list) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'amt'; b.textContent = '$' + n; b.setAttribute('aria-pressed', 'false');
    b.onclick = () => { picked = String(n); $('usd').value = ''; document.querySelectorAll('.amt').forEach(x => x.setAttribute('aria-pressed', String(x === b))); };
    box.append(b);
  }
}
addAmounts($('g1'), [10, 15, 20]); addAmounts($('g2'), [25, 30, 40, 50, 75, 100]);
$('more').onclick = () => { $('g2').hidden = !$('g2').hidden; $('more').textContent = $('g2').hidden ? 'Show more amounts' : 'Show fewer amounts'; };
$('usd').addEventListener('input', () => { picked = ''; document.querySelectorAll('.amt').forEach(x => x.setAttribute('aria-pressed', 'false')); });

$('go').addEventListener('click', async () => {
  const usd = $('usd').value.trim() || picked; $('err').textContent = '';
  if (!usd) { $('err').textContent = 'Choose or enter an amount.'; return; }
  $('go').disabled = true;
  try {
    const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usd }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    location.hash = j.ref; load();
  } catch (x) { $('err').textContent = x.message; }
  $('go').disabled = false;
});

async function load() {
  const ref = location.hash.slice(1); if (!ref) return show('start');
  clearInterval(poll); clearInterval(tick);
  const get = async () => {
    try {
      const r = await fetch('/api/order/' + encodeURIComponent(ref));
      if (!r.ok) { clearInterval(poll); return show('start'); }
      o = await r.json(); offset = o.serverNow - Math.floor(Date.now() / 1000); render();
    } catch { $('chip').textContent = 'RECONNECTING'; }
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
  show('pay'); $('chip').textContent = 'AWAITING PAYMENT';
  $('usdOut').textContent = '$' + o.usd; $('ref').textContent = o.ref;
  $('inv').textContent = o.bolt11.slice(0, 14) + '...' + o.bolt11.slice(-8);
  $('meta').textContent = `${Number(o.sats).toLocaleString()} sats (${o.btc} BTC) at $${o.rate}/BTC, locked ${new Date(o.rateAt * 1000).toLocaleTimeString()}`;
  if (o.cashAppLink) { $('cash').href = o.cashAppLink; $('cash').hidden = false; } else $('cash').hidden = true;
  if (qrFor !== o.ref) {
    qrFor = o.ref; $('qr').textContent = '';
    new QRCode($('qr'), { text: 'lightning:' + o.bolt11, width: 250, height: 250, correctLevel: QRCode.CorrectLevel.L });
  }
  count();
}

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(o.bolt11); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed'; }
  setTimeout(() => $('copy').textContent = 'Copy', 2000);
});
window.addEventListener('hashchange', load); load();
