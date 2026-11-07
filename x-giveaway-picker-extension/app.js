// vibe coded by @ZiggysGlizzy on X
/*
 * Shared UI for the pinned popup (popup.html) and the picker tab (panel.html).
 * It only edits the form and sends commands; the service worker owns jobs and state.
 */
'use strict';
const $=id=>document.getElementById(id);
let state={}, chips=[], excludes=[], loaded=false, busy=false, saving=Promise.resolve(), pendingSaves=0, launching=false;
const fields={postUrl:'value',reqFollow:'checked',reqLike:'checked',reqComment:'checked',reqRepostOrQuote:'checked',winnerCount:'value',sweeps:'value',seed:'value',followHandle:'value',excludeInput:'value'};
const mapping={reqFollow:'requireFollow',reqLike:'requireLike',reqComment:'requireComment',reqRepostOrQuote:'requireRepostOrQuote',seed:'seedText',followHandle:'followDraft',excludeInput:'excludeDraft'};
const normalize=h=>h.trim().replace(/^@+/,'').toLowerCase();
const validHandle=h=>/^[a-z0-9_]{1,15}$/.test(h);
const isPopup=!document.body.classList.contains('full-page');
// Reads {user} from https://x.com/{user}/status/{id} (twitter.com accepted too).
function postAuthor(url) {
  try {
    const u=new URL(String(url||'').trim());
    if(!['x.com','www.x.com','mobile.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(u.hostname)) return null;
    const m=u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
    const h=m&&m[1].toLowerCase();
    return h&&h!=='i'&&validHandle(h)?h:null;
  } catch {return null;}
}
async function send(type,data={}) {
  const res=await chrome.runtime.sendMessage({type,...data});
  if(!res?.ok) throw Error(res?.error||'Background unavailable. Reload the extension.');
  return res;
}
function error(e) {$('status').textContent=e.message||String(e);}
// Snapshot of every form field in the shape the service worker expects.
function form() {
  const f={followHandles:[...chips],excludeHandles:[...excludes]};
  for(const [id,prop] of Object.entries(fields)) f[mapping[id]||id]=$(id)[prop];
  return f;
}
// Queue a SAVE_FORM so rapid edits are written in order.
function save() {
  if(!loaded || busy) return saving;
  const f=form();pendingSaves++;
  saving=saving.catch(()=>{}).then(()=>send('SAVE_FORM',{form:f})).finally(()=>{pendingSaves--;});
  saving.catch(error); return saving;
}
// Render removable @chips into a container.
function chipList(box,list,cls,onRemove) {
  $(box).replaceChildren();
  for(const h of list) {
    const chip=document.createElement('span');chip.className='chip'+(cls?' '+cls:'');chip.append('@'+h);
    const remove=document.createElement('button');remove.type='button';remove.textContent='×';
    remove.setAttribute('aria-label',`Remove @${h}`);remove.disabled=busy;
    remove.onclick=()=>onRemove(h);
    chip.append(remove);$(box).append(chip);
  }
}
function renderSuggestions() {
  // ? suggestions: post author + every must-follow (eligibility followage) handle not yet excluded.
  const author=postAuthor($('postUrl').value);
  const list=[...new Set([author,...chips].filter(Boolean))].filter(h=>!excludes.includes(h));
  $('excludeSuggest').replaceChildren();
  for(const h of list) {
    const b=document.createElement('button');b.type='button';b.className='suggest';b.disabled=busy;
    const q=document.createElement('span');q.className='q';q.textContent='?';
    b.append(q,'@'+h);
    b.title=h===author?'Post author — click to exclude':'Must-follow account — click to exclude';
    b.setAttribute('aria-label',`Exclude @${h}?`);
    b.onclick=()=>{if(!excludes.includes(h)) excludes.push(h);renderChips();void save();};
    $('excludeSuggest').append(b);
  }
  $('excludeSuggestWrap').hidden=!list.length;
}
function renderChips() {
  chipList('chips',chips,'',h=>{chips=chips.filter(x=>x!==h);renderChips();void save();});
  chipList('excludeChips',excludes,'exclude',h=>{excludes=excludes.filter(x=>x!==h);renderChips();void save();});
  renderSuggestions();
}
// Enter-to-add: validate the typed handle and append it as a chip.
function addTo(inputId,list) {
  const raw=$(inputId).value;if(!raw.trim()) return true;
  const h=normalize(raw);
  if(!validHandle(h)) {error(Error('Handle must be 1–15 letters, digits or underscores.'));return false;}
  if(!list.includes(h)) list.push(h);
  $(inputId).value='';renderChips();void save();return true;
}
const addChip=()=>addTo('followHandle',chips);
const addExclude=()=>addTo('excludeInput',excludes);
function autoFollowFromUrl() {
  // Adds the post author as a must-follow chip; never removes anything.
  const h=postAuthor($('postUrl').value);
  if(h&&!chips.includes(h)) {chips.push(h);return true;}
  return false;
}
// Must-follow chips show only while Must follow is on. Also shows the one-time V0.9 bonus migration notice.
function syncFollowUI() {
  $('followWrap').hidden=!$('reqFollow').checked;
  const legacy=state.legacyBonusHandles||[];
  $('legacyNotice').hidden=!legacy.length;
  $('legacyText').textContent=legacy.length?`Bonus point follows was removed in V1.0. These old bonus accounts were NOT made required: ${legacy.map(h=>'@'+h).join(', ')}. Add any you want as must-follow chips.`:'';
}
// Paint the whole UI from service-worker state.
function render(s,initial=false) {
  const wasBusy=busy;state=s;busy=!!(s.collecting||s.picking);
  // Do not rewrite the active editor on each progress/storage event.
  if(initial || busy || wasBusy || !pendingSaves) {
    const f=s.form||{};
    for(const [id,prop] of Object.entries(fields)) if(f[mapping[id]||id]!=null && (initial||busy||wasBusy||document.activeElement!==$(id))) $(id)[prop]=f[mapping[id]||id];
    chips=[...(f.followHandles||[])];
    excludes=[...(f.excludeHandles||[])];
  }
  renderChips();
  syncFollowUI();
  for(const id of Object.keys(fields)) $(id).disabled=busy;
  $('btnCollect').disabled=busy;
  $('btnPick').disabled=busy||!(s.eligible||[]).length;
  $('btnStop').disabled=!busy;
  $('btnReset').disabled=busy;
  $('btnCopy').disabled=!(s.winners||[]).length;
  $('separateTab').checked=s.separateTab!==false;
  $('status').textContent=s.status||'Ready.';
  $('counts').textContent=`Candidates: ${(s.eligible||[]).length} · `+Object.entries(s.buckets||{}).map(([k,v])=>`${k}: ${v.length}`).join(' · ');
  renderCoverage(s);
  renderSweepLog(s);
  $('winnersSection').classList.toggle('hidden',!(s.winners||[]).length);
  $('winnersList').replaceChildren();
  for(const h of s.winners||[]) {
    const li=document.createElement('li'),a=document.createElement('a');
    a.href=`https://x.com/${encodeURIComponent(h)}`;a.textContent='@'+h;a.target='_blank';a.rel='noreferrer';
    const verified=s.winnerDetails?.[h]?.verdict==='verified';
    const badge=document.createElement('span');badge.className='badge '+(verified?'ok':'review');
    badge.textContent=verified?'VERIFIED':'NEEDS REVIEW';
    const rd=document.createElement('button');rd.type='button';rd.className='quiet redraw';rd.textContent='Redraw';
    rd.disabled=busy||!s.draw;rd.setAttribute('aria-label',`Redraw @${h}`);
    rd.onclick=()=>send('REDRAW',{handle:h}).catch(error);
    li.append(a,' ',badge,' ',rd,actionChips(s.winnerChips?.[h]));$('winnersList').append(li);
  }
  const ws=s.winners||[], ok=ws.filter(h=>s.winnerDetails?.[h]?.verdict==='verified').length;
  $('seedUsed').textContent=`Seed used: ${s.seed??'—'} · ${ok} verified · ${ws.length-ok} need review`;
}
// Coverage ESTIMATE after Collect: per-rule handles vs public action totals, plus union + action proxy.
function renderCoverage(s) {
  const box=$('coverage'),c=s.coverage;box.replaceChildren();
  const line=(t,cls='')=>{const p=document.createElement('p');p.className='cov '+cls;p.textContent=t;box.append(p);};
  if(s.collecting){line('Coverage estimate: shown after Collect finishes.');return;}
  if(!c) return;
  line('Coverage estimate (not exact; public totals count actions, not unique people)','cov-head');
  if(c.state==='unavailable'&&c.error) line(`Unavailable: ${c.error}. Collected lists are kept and Pick still works.`,'warn');
  for(const r of c.rows||[]) line('• '+r.text,['mismatch','over-approx'].includes(r.flag)?'warn':'');
  const o=c.overall;
  if(o){
    line(`Unique handles captured (union of enabled lists): ${o.union}. Total unique entrants is unknown.`);
    if(o.allZero) line('Overall action-count proxy: no % — every required public total was read as 0 (this is a valid result, not a missing total).');
    else line(o.actionProxyPct!=null?`Overall action-count proxy: ${o.approx?'≈':''}${o.actionProxyPct}% (Σ collected handles ÷ Σ public action totals — NOT a % of people; repeat replies/quotes and people doing several actions skew it).`
      :`Overall action-count proxy: unavailable — public total missing for ${(o.missing||[]).join(', ')||'a required rule'} (see the rows above).`);
  }
  if(c.repostButton) line(`Repost button counter: ${c.repostButton.approx?'≈':''}${c.repostButton.value} (may or may not include quotes; not used in %).`);
}
// Persistent per-sweep breakdown (counts only), saved in zgState so it survives closing the popup.
const ACTION_NAMES={liked:'likes',reposted:'reposts',quoted:'quotes',repostOrQuote:'repost-or-quote (combined)',commented:'replies'};
function renderSweepLog(s) {
  const box=$('sweepLog'),log=s.sweepLog;box.replaceChildren();
  if(!log||!log.entries?.length) return;
  const p=(t,cls='')=>{const e=document.createElement('p');e.className='cov '+cls;e.textContent=t;box.append(e);};
  p(`Sweep breakdown (${log.sweeps} sweep${log.sweeps>1?'s':''} set)`,'cov-head');
  for(const e of log.entries) {
    const tag=e.status==='complete'?'complete':e.status==='interrupted'?`INTERRUPTED — partial${e.error?': '+e.error:''}`:'in progress — partial';
    const acts=Object.entries(e.actions).map(([k,v])=>e.sweep===1
      ? `${ACTION_NAMES[k]} ${v.total}`
      : `${ACTION_NAMES[k]} +${v.new} new (now ${v.total})`).join(' · ')||'no list finished yet';
    p(`Sweep ${e.sweep}/${log.sweeps} (${tag}): ${acts}`,e.status==='complete'?'':'warn');
    p(e.sweep===1?`  Unique people (union of all lists): ${e.unionTotal}`
      :`  New unique people this sweep: +${e.unionNew} (now ${e.unionTotal}). Per-list "new" counts can overlap; this line counts each person once.`);
  }
}
// Green/red chips for each scraped action under a winner (built in background.js).
function actionChips(list=[]) {
  const box=document.createElement('div');box.className='action-chips';
  for(const c of list) {
    const chip=document.createElement(c.href?'a':'span');
    chip.className='action '+(c.review?'review':c.ok?'ok':'no');
    chip.textContent=(c.review?'⚠ ':c.ok?'✓ ':'✗ ')+c.label;if(c.title) chip.title=c.title;
    if(c.href) {chip.href=c.href;chip.target='_blank';chip.rel='noreferrer';}
    box.append(chip);
  }
  return box;
}
$('followHandle').addEventListener('keydown',e=>{
  if(e.key==='Enter') {e.preventDefault();addChip();}
  if(e.key==='Backspace'&&!e.currentTarget.value&&chips.length) {e.preventDefault();chips.pop();renderChips();void save();}
});
$('excludeInput').addEventListener('keydown',e=>{
  if(e.key==='Enter') {e.preventDefault();addExclude();}
  if(e.key==='Backspace'&&!e.currentTarget.value&&excludes.length) {e.preventDefault();excludes.pop();renderChips();void save();}
});
for(const id of Object.keys(fields)) $(id).addEventListener('input',()=>{
  if(id==='reqFollow') syncFollowUI();
  if(id==='postUrl') {autoFollowFromUrl();renderChips();}
  void save();
});
// Version from manifest.json, shown in the ⚙ menu beside the picker-tab controls.
$('version').textContent=`Version ${chrome.runtime.getManifest?.().version ?? ''}`;
$('gear').onclick=()=>{const open=$('settings').classList.toggle('hidden')===false;$('gear').setAttribute('aria-expanded',String(open));};
// Turning the companion tab on (or Open picker tab) selects that tab; the popup then closes itself.
const closePopup=()=>{if(isPopup) window.close();};
$('separateTab').onchange=()=>send('SET_SETTINGS',{separateTab:$('separateTab').checked})
  .then(()=>{if($('separateTab').checked) closePopup();}).catch(error);
$('openPanel').onclick=()=>send('OPEN_PANEL').then(closePopup).catch(error);
// Collect / Pick: flush pending chip text, save, then hand the job to the service worker.
async function run(type) {
  if(busy||launching)return;
  if(!addChip()||!addExclude())return;
  launching=true;
  try {await save();} catch(e) {launching=false;throw e;}
  const f=form();
  $('btnCollect').disabled=$('btnPick').disabled=true;
  try {await send(type,{form:f});const res=await send('GET_STATE');render(res.state);
    if(res.state.separateTab!==false) closePopup(); // picker tab takes over status + Stop
  }
  catch(e) {error(e);$('btnCollect').disabled=false;$('btnPick').disabled=!(state.eligible||[]).length;}
  finally {launching=false;}
}
$('btnCollect').onclick=()=>run('START').catch(error);
$('btnPick').onclick=()=>run('PICK').catch(error);
$('btnStop').onclick=()=>send('STOP').catch(error);
$('btnReset').onclick=()=>send('RESET').catch(error);
$('legacyDismiss').onclick=()=>send('DISMISS_LEGACY').catch(error);
// Copy/export text: VERIFIED only when every active rule was confirmed live.
function reviewText(h) {
  const d=state.winnerDetails?.[h];
  if(d?.verdict==='verified') return 'VERIFIED';
  const items=[...Object.entries(d?.follows||{}).filter(([,r])=>r.state!=='confirmed').map(([t])=>`following @${t}`),
    ...Object.entries(d?.rules||{}).filter(([,r])=>r.state!=='confirmed').map(([k])=>k)];
  return `NEEDS REVIEW${items.length?': '+items.join(', '):''}`;
}
$('btnCopy').onclick=async()=>{
  try {await navigator.clipboard.writeText(["Ziggy's Giveaway Picker results",state.form?.postUrl,`Seed: ${state.seed}`,
    ...(state.winners||[]).map((h,i)=>`${i+1}. @${h} — ${reviewText(h)}`)].join('\n'));$('status').textContent='Results copied. Nothing posted.';}
  catch(e){error(e);}
};
// Keep popup and picker tab in sync with saved state.
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&changes.zgState?.newValue&&loaded)render(changes.zgState.newValue);
});
(async()=>{
  const res=await send('GET_STATE');render(res.state,true);loaded=true;
  // Popup opened with the companion setting on: make sure the picker tab exists (in the background).
  if(isPopup && res.state.separateTab!==false) await send('OPEN_PANEL',{focus:false});
})().catch(error);
