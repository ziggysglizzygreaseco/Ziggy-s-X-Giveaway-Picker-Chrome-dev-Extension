// vibe coded by @ZiggysGlizzy on X
/* Winners celebration tab: renders the last draw saved in storage as zgWinners, with per-winner Redraw. */
'use strict';

const $ = id => document.getElementById(id);
let busy = false;

// One <li> per winner: profile link, VERIFIED / NEEDS REVIEW badge, Redraw, and action chips.
// V1.4: "Verify followage" at the end of an entry with a needs-review follow chip, plus last results.
const MULTI_NOTE = 'For multiple accounts, it cannot auto-reverify followage.';
function verifyParts(h, chips, detail, st) {
  const out = [], results = Object.entries(detail?.follows || {}).filter(([,r]) => r.manual).map(([t,r]) => `@${t}: ${r.manual}`);
  if (results.length) {const p = document.createElement('p'); p.className = 'verify-result'; p.textContent = 'Verify followage — ' + results.join(' · '); out.push(p);}
  if (!chips.some(c => c.review && c.follow)) return out;
  const wrap = document.createElement('div'); wrap.className = 'verify-wrap';
  const b = document.createElement('button'); b.type = 'button'; b.className = 'verify'; b.textContent = 'Verify followage';
  b.disabled = busy || !!st?.verifying; b.setAttribute('aria-label', `Verify followage for @${h}`);
  b.onclick = async () => {
    b.disabled = true;
    const res = await chrome.runtime.sendMessage({type:'VERIFY_FOLLOW', handle:h}).catch(e => ({ok:false, error:e.message}));
    $('status').textContent = res?.ok ? `Verify followage: checking @${h}…` : (res?.error || 'Verify followage failed.');
    if (!res?.ok) b.disabled = false;
  };
  const note = document.createElement('span'); note.className = 'verify-note'; note.textContent = MULTI_NOTE;
  wrap.append(b, ' ', note); out.push(wrap); return out;
}
let st = null;
function winnerItem(h, chips = [], detail) {
  const li = document.createElement('li'), a = document.createElement('a');
  a.href = `https://x.com/${encodeURIComponent(h)}`; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = '@' + h;
  const verified = detail?.verdict === 'verified';
  const badge = document.createElement('span'); badge.className = 'badge ' + (verified ? 'ok' : 'review');
  badge.textContent = verified ? 'VERIFIED' : 'NEEDS REVIEW';
  const rd = document.createElement('button'); rd.type = 'button'; rd.className = 'redraw'; rd.textContent = 'Redraw';
  rd.disabled = busy; rd.setAttribute('aria-label', `Redraw @${h}`);
  rd.onclick = async () => {
    rd.disabled = true;
    const res = await chrome.runtime.sendMessage({type:'REDRAW', handle:h}).catch(e => ({ok:false, error:e.message}));
    $('status').textContent = res?.ok ? `Redrawing @${h}… (live re-check running)` : (res?.error || 'Redraw failed.');
  };
  const box = document.createElement('div'); box.className = 'action-chips';
  for (const c of chips) {
    const chip = document.createElement(c.href ? 'a' : 'span');
    chip.className = 'action ' + (c.review ? 'review' : c.ok ? 'ok' : 'no');
    chip.textContent = (c.review ? '⚠ ' : c.ok ? '✓ ' : '✗ ') + c.label;
    if (c.title) chip.title = c.title;
    if (c.href) {chip.href = c.href; chip.target = '_blank'; chip.rel = 'noreferrer';}
    box.append(chip);
  }
  li.append(a, ' ', badge, ' ', rd, box, ...verifyParts(h, chips, detail, st));
  return li;
}

async function load() {
  const {zgWinners:payload, zgState:stNow} = await chrome.storage.local.get(['zgWinners','zgState']);
  st = stNow; busy = !!(st?.collecting || st?.picking);
  $('status').textContent = st?.status || '';
  if (!payload || !Array.isArray(payload.winners) || !payload.winners.length) {
    $('empty').classList.remove('hidden');
    $('list').classList.add('hidden');
    return;
  }
  $('empty').classList.add('hidden'); $('list').classList.remove('hidden');
  $('list').replaceChildren(...payload.winners.map(h => winnerItem(h, payload.winnerChips?.[h], payload.winnerDetails?.[h])));
  const ok = payload.winners.filter(h => payload.winnerDetails?.[h]?.verdict === 'verified').length;
  const bits = [`${ok} verified · ${payload.winners.length - ok} need review`];
  if (payload.seed != null) bits.push(`Seed used: ${payload.seed}`);
  if (payload.eligibleCount != null) bits.push(`Eligible pool: ${payload.eligibleCount}`);
  $('meta').textContent = bits.join(' · ');
  if (payload.postUrl) $('post').textContent = payload.postUrl;
}

const fail = err => {
  $('empty').classList.remove('hidden');
  $('empty').textContent = 'Could not load winners: ' + (err?.message || String(err));
};
// Stay in sync with redraws/second-pass updates from the picker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.zgWinners || changes.zgState)) load().catch(fail);
});
load().catch(fail);
