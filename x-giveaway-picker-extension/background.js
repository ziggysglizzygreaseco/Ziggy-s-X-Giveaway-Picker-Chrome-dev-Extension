// vibe coded by @ZiggysGlizzy on X
/*
 * Service worker: owns every job (collect, pick, stop) and all saved state.
 * Read-only toward X: it opens X pages in the user's own Chrome, asks content.js
 * to read handles from the rendered page, and never posts, follows, likes or DMs.
 */
'use strict';


const DEFAULT_FORM = {postUrl:'', requireFollow:true, followHandles:[], requireLike:true,
  requireComment:false, requireRepostOrQuote:true, excludeHandles:[], winnerCount:1, seedText:'', sweeps:2};
const FOLLOW_TIMEOUT_MS = 150000;        // one winner's following check (hung checks are skipped)
const SCAN_TIMEOUT_MS = 35 * 60 * 1000;  // safety ceiling for a big likes/reposts/replies scan
const MAX_SECOND_PASS_ROUNDS = 12;       // live re-check rounds per draw/redraw (stops endless repicks)
const LEGACY_FORM_KEYS = ['bonusFollows','mainAccount','bonusHandles','bonusDraft'];

let state, writeQueue = Promise.resolve(), job = null, stopFlag = false;

const norm = h => String(h || '').trim().replace(/^@+/, '').toLowerCase();
const valid = h => /^[a-z0-9_]{1,15}$/.test(h);
const delay = ms => new Promise(r => setTimeout(r, ms));
const panelUrl = () => chrome.runtime.getURL('panel.html');
const isFollowScan = mode => ['following','profileFollow','postCounts'].includes(mode);
const clone = v => JSON.parse(JSON.stringify(v));

/*
 * V0.9 -> V1.0 migration of the removed "bonus point follows" feature. Non-destructive:
 * existing must-follow chips are kept as-is. A V0.9 main account that was a HARD requirement
 * (bonus on + Must follow on) stays required by becoming a chip. Bonus-only handles were never
 * required, so they are NOT turned into new requirements; they are reported back as a notice.
 */
function migrateLegacyForm(raw) {
  const f = {...(raw || {})}, notice = [];
  if (LEGACY_FORM_KEYS.some(k => k in f)) {
    const follows = [...(f.followHandles || [])].map(norm).filter(valid);
    const main = valid(norm(f.mainAccount)) ? norm(f.mainAccount) : '';
    if (f.bonusFollows && f.requireFollow !== false && main && !follows.includes(main)) follows.push(main);
    const optional = [...(f.bonusHandles || []), ...(f.bonusFollows && f.requireFollow === false ? [main] : [])]
      .map(norm).filter(valid).filter(h => !follows.includes(h));
    notice.push(...new Set(optional));
    f.followHandles = follows;
    for (const k of LEGACY_FORM_KEYS) delete f[k];
  }
  return {form:f, legacyBonusHandles:notice};
}

// Load saved state once per worker start; migrate older saved shapes.
const ready = (async () => {
  const saved = await chrome.storage.local.get('zgState');
  state = Object.assign({form:DEFAULT_FORM, eligible:[], buckets:{}, status:'Ready to collect.',
    collecting:false, picking:false, winners:[], winnerChips:{}, winnerDetails:{}, draw:null, seed:null,
    separateTab:true, ownedTabs:[], legacyBonusHandles:[]}, saved.zgState || {});
  const m = migrateLegacyForm(state.form);
  if (m.legacyBonusHandles.length) state.legacyBonusHandles = [...new Set([...(state.legacyBonusHandles||[]), ...m.legacyBonusHandles])];
  // Drop any invalid saved must-follow handle rather than failing worker start-up.
  state.form = cleanForm({...m.form, followHandles:(m.form.followHandles||[]).map(norm).filter(valid)});
  if (state.collectedForm) state.collectedForm = cleanForm(migrateLegacyForm(state.collectedForm).form);
  delete state.chips; delete state.verifyCache; // pre-V0.6 chips; V0.9 follow cache (not used by V1.0)
  // A worker/browser restart cannot resume an in-flight DOM scan safely.
  if (state.collecting || state.picking || state.ownedTabs.length) {
    for (const id of state.ownedTabs) await chrome.tabs.remove(id).catch(() => {});
    state.collecting = state.picking = false; state.ownedTabs = [];
    state.status = 'Previous operation interrupted. Saved pools retained; collect again if incomplete.';
  }
  await chrome.storage.local.set({zgState:state});
})();

// Serialized state writes, broadcast to any open popup/panel.
function patch(values) {
  const next = writeQueue.then(async () => {await ready; Object.assign(state, values);
    await chrome.storage.local.set({zgState:state});
    chrome.runtime.sendMessage({type:'PROGRESS', status:state.status}).catch(() => {});
  });
  writeQueue = next.catch(() => {}); return next;
}

// Normalize the form coming from the UI (or old saved state). Unknown legacy keys are dropped.
function cleanForm(raw) {
  const f = {...DEFAULT_FORM, ...raw};
  for (const k of LEGACY_FORM_KEYS) delete f[k];
  f.followHandles = [...new Set((f.followHandles || []).map(norm))];
  if (f.followHandles.some(h => !valid(h))) throw Error('Invalid must-follow handle.');
  const ex = Array.isArray(raw?.excludeHandles) ? raw.excludeHandles : (raw?.excludeHandle ? [raw.excludeHandle] : []);
  f.excludeHandles = [...new Set(ex.map(norm).filter(valid))];
  delete f.excludeHandle;
  f.winnerCount = Math.max(1, Math.min(50, Number.parseInt(f.winnerCount,10) || 1));
  f.sweeps = Math.max(1, Math.min(3, Number.parseInt(f.sweeps,10) || 2)); // Collect sweeps 1–3, default 2
  return f;
}

// Accounts every winner must follow (all of them). Follow required off: none.
const hardFollows = f => f.requireFollow ? f.followHandles : [];

// Canonical https://x.com/{user}/status/{id} for a pasted x.com/twitter.com post link.
function postBase(url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/([\w]{1,15})\/status\/(\d+)\/?$/);
  if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname) || !m) throw Error('Enter a valid X post link.');
  return `https://x.com/${m[1]}/status/${m[2]}`;
}
const postAuthor = url => {try {return norm(new URL(postBase(url)).pathname.split('/')[1]);} catch {return '';}};

function check(token) {if (stopFlag || job !== token) throw Error('Stopped.');}

/*
 * Show the picker tab. Always a soft tab switch (tabs.update active) so scans never
 * yank Chrome windows around. focusWindow is only for an explicit user click
 * (toggle / "Open picker tab"), where bringing that tab's window forward is wanted.
 */
async function openPanel(active = true, focusWindow = false) {
  const existing = (await chrome.tabs.query({})).find(t => t.url === panelUrl());
  const tab = existing ? (active ? await chrome.tabs.update(existing.id,{active:true}) : existing)
    : await chrome.tabs.create({url:panelUrl(), active});
  if (focusWindow && tab?.windowId != null) await chrome.windows.update(tab.windowId,{focused:true}).catch(() => {});
}

/*
 * Open one X page, keep it the selected tab for the whole step (Chrome throttles
 * background tabs, which stalls scrolling), run one content.js scan, then close it.
 */
async function page(token,url,mode,options={}) {
  check(token);
  const tab = await chrome.tabs.create({url,active:false}); token.tabs.add(tab.id);
  let timer, expired = false;
  const assertActive = () => {check(token); if (expired) throw Error('X scan timed out.');};
  try {
    const scan = async () => {
      await chrome.tabs.update(tab.id,{active:true}); assertActive();
      await patch({ownedTabs:[...token.tabs]}); assertActive();
      const started = Date.now();
      while ((await chrome.tabs.get(tab.id)).status !== 'complete') {
        assertActive();
        if (Date.now()-started > 60000) throw Error('X page load timed out.');
        await delay(300);
      }
      await delay(1000); assertActive();
      try {await chrome.tabs.sendMessage(tab.id,{type:'PING'});}
      catch {assertActive(); await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}
      assertActive();
      // content.js acks immediately and reports the result later via PAGE_RESULT.
      const completion = new Promise((resolve,reject) => token.pending.set(tab.id,{resolve,reject}));
      completion.catch(() => {});
      const ack = await chrome.tabs.sendMessage(tab.id,{type:'COLLECT_PAGE',mode,options:{...options,jobId:token.id}});
      assertActive();
      const result = ack?.started ? await completion : ack;
      assertActive();
      if (!result?.ok) throw Error(result?.error || 'X collection failed.');
      return result;
    };
    // The outer deadline covers load, injection, ack and result, so a hung check always ends.
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => {
        expired = true;
        chrome.tabs.sendMessage(tab.id,{type:'ABORT'}).catch(() => {});
        reject(Error(isFollowScan(mode) ? (mode==='postCounts' ? 'Reading public totals timed out (150 seconds).' : 'Following verification timed out (150 seconds).') : 'X scan exceeded the 35-minute safety timeout.'));
      }, isFollowScan(mode) ? FOLLOW_TIMEOUT_MS : SCAN_TIMEOUT_MS);
    });
    return await Promise.race([scan(),deadline]);
  } finally {
    expired = true; clearTimeout(timer);
    token.pending.get(tab.id)?.reject(Error('X scan finished or cancelled.'));
    token.pending.delete(tab.id);
    token.tabs.delete(tab.id); await chrome.tabs.remove(tab.id).catch(() => {});
    if (job === token) {
      await patch({ownedTabs:[...token.tabs]});
      // Companion setting OFF: softly reselect the picker between steps.
      if (!state.separateTab && !stopFlag) await openPanel();
    }
  }
}

const excluded = (form,h) => form.excludeHandles.includes(h);

// Unique candidates = union of every enabled engagement bucket, minus exclusions.
function pool(buckets, form) {
  const sets = [];
  if (form.requireLike) sets.push(buckets.liked || []);
  if (form.requireComment) sets.push(buckets.commented || []);
  if (form.requireRepostOrQuote) sets.push(buckets.repostOrQuote || []);
  return [...new Set(sets.flat())].filter(h => valid(h) && !excluded(form,h)).sort();
}

// AND rule: the candidate must be in every enabled bucket.
function engagementOK(h,f,b) {
  return (!f.requireLike || (b.liked||[]).includes(h)) &&
    (!f.requireComment || (b.commented||[]).includes(h)) &&
    (!f.requireRepostOrQuote || (b.repostOrQuote||[]).includes(h)) && !excluded(f,h);
}

/*
 * Winner chips. Active draw rules show their LIVE second-pass result; scraped buckets for
 * rules that were not active still show the collected green/red chip (V0.9 behavior).
 * review chips carry an href so the UI can render a clickable "needs review" link.
 */
const RULE_LABELS = {like:'liked', comment:'commented', repostOrQuote:'reposted or quoted'};
function actionChips(h,f,b,detail) {
  const chips = [], base = postBase(f.postUrl), rules = detail?.rules || {};
  for (const [t,r] of Object.entries(detail?.follows || {})) {
    if (r.state === 'confirmed') chips.push({label:`follows @${t} · ${r.path.replaceAll('-',' ')}`, ok:true});
    else chips.push({label:`needs review on following @${t}`, review:true, href:`https://x.com/${t}`, title:r.reason});
  }
  const ruleChip = (key,url) => {
    const r = rules[key];
    if (r.state === 'confirmed') chips.push({label:`${RULE_LABELS[key]} · live`, ok:true});
    else if (r.state === 'review') chips.push({label:`needs review: ${RULE_LABELS[key]}`, review:true, href:url, title:r.reason});
    else chips.push({label:`${RULE_LABELS[key]} · not seen live`, ok:false, title:r.reason});
  };
  if (rules.like) ruleChip('like',`${base}/likes`);
  else if (b.liked) chips.push({label:'liked', ok:b.liked.includes(h)});
  if (rules.repostOrQuote) ruleChip('repostOrQuote',`${base}/retweets`);
  else if (b.reposted || b.quoted || b.repostOrQuote)
    chips.push({label:'reposted or quoted', ok:[...(b.reposted||[]),...(b.quoted||[]),...(b.repostOrQuote||[])].includes(h)});
  if (rules.comment) ruleChip('comment',base);
  else if (b.commented) chips.push({label:'commented', ok:b.commented.includes(h)});
  return chips;
}

// Stable seeded Fisher–Yates (mulberry32) over the sorted unique handles.
function seededOrder(items, seed) {
  let a = seed >>> 0;
  const rand = () => {a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15),t|1); t ^= t + Math.imul(t ^ (t >>> 7),t|61);
    return ((t ^ (t >>> 14)) >>> 0)/4294967296;};
  const out = [...new Set(items)].sort();
  for (let i=out.length-1;i>0;i--) {const j=Math.floor(rand()*(i+1)); [out[i],out[j]]=[out[j],out[i]];}
  return out;
}


// Collect each enabled engagement list into its own bucket, in f.sweeps (1–3) sweeps per Collect.
// Later sweeps re-read the same enabled lists and MERGE (dedupe) into earlier buckets; nothing
// is cleared between sweeps. All sweeps use the same rule snapshot `f`. Stop/error keeps what finished.
async function collect(token,f) {
  const SWEEPS = f.sweeps;
  const base = postBase(f.postUrl), buckets = {}, followHints = {}, diagnostics = {};
  let sweep = 1;
  /*
   * Persistent sweep log (saved in zgState like the lists themselves; counts only, no handles).
   * Per sweep: per action raw handles read this sweep, NEW to that action's merged list, merged total;
   * repost-or-quote combined; and NEW unique people across all enabled lists (Set union delta).
   */
  const unionOf = () => new Set(['liked','reposted','quoted','commented'].flatMap(k => buckets[k] || []));
  const sweepLog = {sweeps:SWEEPS, entries:[]};
  let entry = null;
  const startSweep = async () => {
    entry = {sweep, status:'in-progress', actions:{}, rqStart:(buckets.repostOrQuote || []).length, unionStart:unionOf().size, unionNew:0, unionTotal:unionOf().size};
    sweepLog.entries.push(entry); await patch({sweepLog:clone(sweepLog)});
  };
  async function scan(key,url,mode,opts={}) {
    check(token); await patch({status:`Sweep ${sweep}/${SWEEPS} · Collecting ${mode}…`});
    const res = await page(token,url,mode,opts); check(token);
    const before = (buckets[key] || []).length;
    const fresh = [...new Set(res.handles.map(norm).filter(valid))];
    buckets[key] = [...new Set([...(buckets[key] || []), ...fresh])];
    if (buckets.reposted && buckets.quoted) buckets.repostOrQuote = [...new Set([...buckets.reposted,...buckets.quoted])];
    entry.actions[key] = {raw:fresh.length, new:buckets[key].length-before, total:buckets[key].length, capped:!!res.diagnostics?.capped};
    if (buckets.repostOrQuote && (key==='quoted' || key==='reposted'))
      entry.actions.repostOrQuote = {new:buckets.repostOrQuote.length-entry.rqStart, total:buckets.repostOrQuote.length};
    const u = unionOf().size; entry.unionNew = u - entry.unionStart; entry.unionTotal = u;
    Object.assign(followHints,res.followHints || {}); diagnostics[`${key}#${sweep}`] = res.diagnostics;
    await patch({buckets:{...buckets}, eligible:pool(buckets,f), followHints:{...followHints}, diagnostics:{...diagnostics}, sweepLog:clone(sweepLog),
      status:`Sweep ${sweep}/${SWEEPS} · ${mode}: ${buckets[key].length} total (+${buckets[key].length-before} new)${res.diagnostics?.capped ? ' (safety limit reached)' : ''}.`});
  }
  try {
  for (; sweep <= SWEEPS; sweep++) {
    await startSweep();
    if (f.requireLike) await scan('liked',`${base}/likes`,'likes');
    if (f.requireRepostOrQuote) {
      await scan('reposted',`${base}/retweets`,'retweets');
      await scan('quoted',`${base}/quotes`,'quotes');
    }
    if (f.requireComment) await scan('commented',base,'replies',{postId:base.split('/').pop(),includeProbableSpam:true,preferAllReplies:true});
    entry.status = 'complete'; await patch({sweepLog:clone(sweepLog)});
  }
  } catch(e) {
    // Stop/error: the running sweep is marked interrupted; its finished scans stay listed as partial.
    if (entry && entry.status !== 'complete') {entry.status = 'interrupted'; entry.error = e.message;}
    if (!job || job === token) await patch({sweepLog:clone(sweepLog)});
    throw e;
  }
  sweep = SWEEPS;
  // Comments-only draws: best-effort follower hints. Hints never exclude anyone; Pick still verifies.
  if (f.requireFollow && f.requireComment && !f.requireLike && !f.requireRepostOrQuote) {
    for (const target of pool(buckets,f).length ? hardFollows(f) : []) {
      await patch({status:`Comments-only: reading @${target}'s followers (best effort)…`});
      const res = await page(token,`https://x.com/${target}/followers`,'followers',{want:pool(buckets,f),maxIdleRounds:30,maxRounds:1500});
      check(token); diagnostics[`followers:${target}`] = res.diagnostics;
      followHints[target] = res.handles;
      await patch({followHints:{...followHints},diagnostics:{...diagnostics}});
    }
  }
  check(token); const eligible = pool(buckets,f);
  await patch({eligible,buckets, collectedForm:f, status:`Collection done (${SWEEPS} sweep${SWEEPS>1?'s':''} merged): ${eligible.length} unique candidates. Reading public totals for coverage…`});
  // Coverage is informational only. A failure here never discards lists or blocks Pick.
  let coverage;
  await patch({status:'Reading the post’s public totals (likes, reposts, quotes, replies) for coverage…'});
  const need = [f.requireLike && 'likes', f.requireComment && 'replies', ...(f.requireRepostOrQuote ? ['reposts','quotes'] : [])].filter(Boolean);
  const r = await attempt(token,base,'postCounts',{postId:base.split('/').pop(),author:postAuthor(base),need,retries:4,retryMs:1500});
  coverage = coverageReport(buckets,f,r.res?.found ? r.res.counts : null,
    r.error ? `Could not read public totals: ${r.error}` : (!r.res?.found ? 'Original post not found on the page; public totals unavailable' : ''),
    r.res?.reasons || {}, r.res?.attempts || 0);
  await patch({eligible,buckets,collectedForm:f,coverage,collecting:false,
    status:`Collection done (${SWEEPS} sweep${SWEEPS>1?'s':''} merged): ${eligible.length} unique candidates. ${coverage.summary} Pick verifies all enabled rules.`});
}

/*
 * Coverage ESTIMATE (informational; never affects eligibility, draw or re-checks).
 * Per enabled rule: collected UNIQUE handles ÷ public ACTION total read from the original post.
 * Public totals count actions (one person can reply/quote many times; overlap across rules), so
 * these are proxies, not "% of people captured". Unreadable totals are 'unavailable', never 0.
 * counts: {likes, reposts, quotes, replies, repostButton} each {value, approx} or null.
 */
function coverageReport(buckets,f,counts,error='',reasons={},attempts=0) {
  const rows = [], len = k => (buckets[k] || []).length;
  const fmt = c => c ? `${c.approx ? '≈' : ''}${c.value.toLocaleString('en-US')}` : 'unavailable';
  const row = (rule,label,collected,total,note='',reason='') => {
    const r = {rule,label,collected,total:total||null,pct:null,flag:'',note,reason:total?'':(reason||error||'not read')};
    if (!total) r.flag = 'unavailable';
    else if (total.value === 0) r.flag = collected ? 'mismatch' : 'zero';
    else {
      r.pct = Math.round(collected / total.value * 1000) / 10;
      if (collected > total.value) r.flag = total.approx ? 'over-approx' : 'mismatch';
      else if (total.approx) r.flag = 'approx';
    }
    r.text = `${label}: ${collected} collected handles vs ${fmt(total)} public ${note || 'actions'}` +
      (r.pct != null ? ` → ${r.flag==='approx'||r.flag==='over-approx' ? '≈' : ''}${r.pct}% proxy` : '') +
      ({unavailable:' (public total unavailable — not counted as 0)', zero:' (public total 0; no %)',
        mismatch:' ⚠ more handles than the public total — counts may be stale/hidden or lists include extra rows',
        'over-approx':' ⚠ above an abbreviated public total', approx:' (public total abbreviated)'}[r.flag] || '') +
      (total?.inferred ? ' [hidden 0 inferred from an empty stat control]' : '') +
      (total?.source ? ` [source: ${total.source}]` : '') + (r.reason ? ` [why: ${r.reason}]` : '');
    rows.push(r); return r;
  };
  const c = counts || {};
  if (f.requireLike) row('like','Likes',len('liked'),c.likes,'likes',reasons.likes);
  if (f.requireRepostOrQuote) {
    row('repost','Reposts (component)',len('reposted'),c.reposts,'reposts',reasons.reposts);
    row('quote','Quotes (component)',len('quoted'),c.quotes,'quotes',reasons.quotes);
    // Combined only when both totals come from separately labelled Reposts and Quotes counts.
    const both = c.reposts && c.quotes ? {value:c.reposts.value + c.quotes.value, approx:c.reposts.approx || c.quotes.approx, source:'Reposts link + Quotes link'} : null;
    row('repostOrQuote','Reposts + quotes (combined)',len('repostOrQuote'),both,
      both ? 'reposts+quotes' : 'reposts+quotes (needs both labelled totals)',
      [!c.reposts && 'Reposts total missing', !c.quotes && 'Quotes total missing'].filter(Boolean).join('; '));
  }
  if (f.requireComment) row('comment','Replies',len('commented'),c.replies,'replies',reasons.replies);
  // Overall: union of collected handles (unique people captured) with NO denominator, plus an
  // action-count proxy = Σ collected handles ÷ Σ public totals over likes, reposts+quotes, replies.
  const keys = [f.requireLike && 'liked', f.requireRepostOrQuote && 'repostOrQuote', f.requireComment && 'commented'].filter(Boolean);
  const union = new Set(keys.flatMap(k => buckets[k] || [])).size;
  const parts = rows.filter(r => ['like','repostOrQuote','comment'].includes(r.rule));
  const ready = parts.length && parts.every(r => r.total);
  const num = parts.reduce((n,r) => n + r.collected, 0), den = ready ? parts.reduce((n,r) => n + r.total.value, 0) : 0;
  const allZero = !error && !!ready && den === 0;
  const overall = {union, actionProxyPct: ready && den > 0 ? Math.round(num/den*1000)/10 : null,
    approx: parts.some(r => r.total?.approx), complete: !!ready, allZero,
    missing: parts.filter(r => !r.total).map(r => r.label)};
  const summary = error ? `Coverage unavailable (${error}).`
    : allZero ? 'Coverage: every required public total read as 0 — no percentage.'
    : overall.actionProxyPct != null ? `Coverage action proxy ${overall.approx ? '≈' : ''}${overall.actionProxyPct}% (estimate, not % of people).`
    : `Coverage partial: public total unavailable for ${overall.missing.join(', ')}.`;
  return {state: error ? 'unavailable' : allZero ? 'zero' : ready ? 'ok' : 'partial', error, rows, overall, summary,
    repostButton: c.repostButton || null, attempts, at: Date.now()};
}

/*
 * LIVE follow check for one candidate (never cached). The post author gets the fast profile
 * "Follows you" proof, accepted ONLY when the logged-in viewer's own handle equals that author.
 * Everything still unresolved shares ONE scan of the candidate's /following list.
 * Not seen / incomplete / timed out => 'review' (never a disqualification, never "confirmed").
 */
async function verifyFollowLive(token,candidate,targets,f) {
  const follows = {}, author = postAuthor(f.postUrl);
  const status = text => patch({status:`Second pass · @${candidate}: ${text}`});
  if (author && targets.includes(author)) {
    await status(`checking profile “Follows you” for @${author}…`);
    const p = await attempt(token,`https://x.com/${candidate}`,'profileFollow',{candidate});
    if (p.res?.followsViewer && p.res.viewerHandle === author) {
      follows[author] = {state:'confirmed', path:'follows-you'};
      await status(`@${author} confirmed via profile “Follows you”.`);
    } else await status(`profile did not confirm @${author}; checking their Following list.`);
  }
  const unresolved = targets.filter(t => !follows[t]);
  if (unresolved.length) {
    await status(`scanning Following list for ${unresolved.map(t=>'@'+t).join(', ')}…`);
    const r = await attempt(token,`https://x.com/${candidate}/following`,'following',
      {want:unresolved,maxIdleRounds:8,maxRounds:100,progressLabel:`Second pass · @${candidate} · following list`});
    for (const t of unresolved) {
      if (r.res?.handles.includes(t)) follows[t] = {state:'confirmed', path:'following-list'};
      else follows[t] = {state:'review', reason: r.error ? `Following check failed: ${r.error}`
        : r.res?.diagnostics?.capped ? 'Following list hit the scan safety cap'
        : `Not seen in @${candidate}'s Following list (X lists can be incomplete)`};
    }
  }
  return follows;
}

// One page scan that reports errors instead of throwing (Stop still throws).
async function attempt(token,url,mode,options) {
  try {const res = await page(token,url,mode,options); check(token); return {res};}
  catch(e) {check(token); return {error:e.message};}
}
// A fresh list is "complete" only if it loaded rows and ended without cap/error.
const scanComplete = r => !!(r.res && !r.res.diagnostics?.capped && (r.res.diagnostics?.rowsSeen || 0) > 0);
function classify(h,scans) {
  if (scans.some(r => r.res?.handles.includes(h))) return {state:'confirmed'};
  if (scans.every(scanComplete)) return {state:'failed', reason:'Not seen in a fresh, completed list (removed or never did it)'};
  const why = scans.map(r => r.error || (r.res?.diagnostics?.capped ? 'scan safety cap' : (r.res ? 'list empty/unavailable' : ''))).filter(Boolean);
  return {state:'review', reason:`Live list incomplete: ${why.join('; ') || 'not seen'}`};
}

/*
 * Second pass: fresh grouped scans of every ACTIVE draw-time rule against just these provisional
 * winners (no collected lists, no cache). Repost OR quote; across rules AND.
 * Returns per handle {verdict:'verified'|'review'|'failed', rules, follows}.
 */
async function secondPass(token,f,handles) {
  const base = postBase(f.postUrl), out = {};
  for (const h of handles) out[h] = {rules:{}, follows:{}};
  const label = handles.map(h=>'@'+h).join(', ');
  const scan = async (url,mode,want,opts={}) => {
    await patch({status:`Second pass: live ${mode} check for ${want.map(h=>'@'+h).join(', ')}…`});
    return attempt(token,url,mode,{want,maxIdleRounds:8,maxRounds:400,progressLabel:`Second pass · ${mode}`,...opts});
  };
  if (f.requireLike) {
    const r = await scan(`${base}/likes`,'likes',handles);
    for (const h of handles) out[h].rules.like = classify(h,[r]);
  }
  if (f.requireRepostOrQuote) {
    const r = await scan(`${base}/retweets`,'retweets',handles);
    const left = handles.filter(h => !r.res?.handles.includes(h));
    const q = left.length ? await scan(`${base}/quotes`,'quotes',left) : null;
    for (const h of handles) out[h].rules.repostOrQuote = classify(h,q && left.includes(h) ? [r,q] : [r]);
  }
  if (f.requireComment) {
    const r = await scan(base,'replies',handles,{postId:base.split('/').pop(),includeProbableSpam:true,preferAllReplies:true});
    for (const h of handles) out[h].rules.comment = classify(h,[r]);
  }
  const targets = hardFollows(f);
  for (const h of handles) {
    const failed = Object.values(out[h].rules).some(r => r.state === 'failed');
    if (!failed && targets.length) out[h].follows = await verifyFollowLive(token,h,targets,f);
    const states = [...Object.values(out[h].rules), ...Object.values(out[h].follows)].map(r => r.state);
    out[h].verdict = failed ? 'failed' : states.every(s => s === 'confirmed') ? 'verified' : 'review';
  }
  await patch({status:`Second pass finished for ${label}.`});
  return out;
}

// Next seeded candidate that passes the collected-snapshot AND rules and is unused this draw.
function nextCandidate(draw) {
  const used = new Set([...draw.slots.filter(Boolean),...draw.discarded,...draw.rejected]);
  while (draw.cursor < draw.order.length) {
    const h = draw.order[draw.cursor++];
    if (used.has(h)) continue;
    if (!engagementOK(h,draw.form,draw.buckets)) {draw.log.push({handle:h,ok:false,reason:'Collected engagement rule failed'}); continue;}
    return h;
  }
  return null;
}

// Persist the draw and publish winners/chips (picker + celebration tab read these).
async function publishDraw(draw,extra={}) {
  const winners = draw.slots.filter(Boolean), winnerChips = {}, winnerDetails = {};
  for (const h of winners) {
    winnerDetails[h] = draw.details[h];
    winnerChips[h] = actionChips(h,draw.form,draw.buckets,draw.details[h]);
  }
  await chrome.storage.local.set({zgWinners:{winners,winnerChips,winnerDetails,seed:draw.seed,postUrl:draw.form.postUrl,
    eligibleCount:draw.order.length,at:Date.now()}});
  await patch({draw:clone(draw),winners,winnerChips,winnerDetails,seed:draw.seed,verificationLog:[...draw.log],...extra});
}
const reviewCount = draw => draw.slots.filter(h => h && draw.details[h]?.verdict !== 'verified').length;

/*
 * Fill empty slots: take seeded candidates, run the live second pass on the batch,
 * repick for any that fail. Bounded by the candidate list and MAX_SECOND_PASS_ROUNDS.
 */
async function fillSlots(token,draw) {
  for (let round = 1; round <= MAX_SECOND_PASS_ROUNDS; round++) {
    check(token);
    const empty = draw.slots.map((h,i) => h ? -1 : i).filter(i => i >= 0);
    if (!empty.length) return true;
    const batch = [];
    for (const i of empty) {const h = nextCandidate(draw); if (!h) break; batch.push([i,h]);}
    if (!batch.length) return false;
    await patch({status:`Second pass round ${round}: live re-checking ${batch.map(([,h])=>'@'+h).join(', ')}…`});
    const res = await secondPass(token,draw.form,batch.map(([,h]) => h)); check(token);
    for (const [i,h] of batch) {
      if (res[h].verdict === 'failed') {
        draw.rejected.push(h); draw.log.push({handle:h,ok:false,reason:'Live second pass: an active rule was not seen in a completed fresh list'});
      } else {
        draw.slots[i] = h; draw.details[h] = res[h];
        draw.log.push({handle:h,ok:true,reason:res[h].verdict === 'verified' ? 'All active rules confirmed live' : 'Provisional: needs review'});
      }
    }
    await publishDraw(draw);
  }
  return !draw.slots.some(h => !h);
}

async function pick(token,f) {
  const b = state.buckets, original = state.collectedForm;
  if (!original || postBase(original.postUrl) !== postBase(f.postUrl)) throw Error('Collect this post first.');
  for (const k of ['requireLike','requireComment','requireRepostOrQuote']) {
    if (f[k] && !original[k]) throw Error('New engagement rule enabled: collect again first.');
  }
  const candidates = pool(b,f); if (!candidates.length) throw Error('No stored candidates. Collect first.');
  let seed = Number(f.seedText);
  if (f.seedText === '' || !Number.isSafeInteger(seed)) seed = crypto.getRandomValues(new Uint32Array(1))[0];
  f.seedText = String(seed);
  // Draw snapshot: rules, collected lists and seeded order are frozen for later redraws.
  const draw = {form:clone(f), seed, buckets:clone(b), order:seededOrder(candidates,seed), cursor:0,
    slots:Array(f.winnerCount).fill(null), discarded:[], rejected:[], details:{}, log:[]};
  await patch({form:f,seed,winners:[],winnerChips:{},winnerDetails:{},draw:null,verificationLog:[],status:'Picking provisional winners…'});
  await chrome.storage.local.remove('zgWinners');
  await fillSlots(token,draw);
  await finishDraw(token,draw,'Draw complete');
  const winners = draw.slots.filter(Boolean);
  if (winners.length) await chrome.tabs.create({url:chrome.runtime.getURL('winners.html'),active:true});
}

async function finishDraw(token,draw,prefix) {
  check(token);
  const n = draw.slots.filter(Boolean).length, review = reviewCount(draw);
  await publishDraw(draw,{picking:false,status:`${prefix}: ${n}/${draw.slots.length} winners · ${n-review} verified · ${review} need review. Nothing posted to X.`});
}

// Redraw one slot under the ORIGINAL draw snapshot. Old winner stays until a replacement passes.
async function redraw(token,handle) {
  const draw = clone(state.draw), i = draw.slots.indexOf(handle);
  if (i < 0) throw Error(`@${handle} is not a current winner.`);
  for (let round = 1; round <= MAX_SECOND_PASS_ROUNDS; round++) {
    check(token);
    const h = nextCandidate(draw);
    if (!h) {
      await publishDraw(draw,{picking:false,status:`Redraw: no other eligible candidate left. @${handle} kept in slot ${i+1}.`});
      return;
    }
    await patch({status:`Redraw slot ${i+1}: live re-checking @${h}…`});
    const res = await secondPass(token,draw.form,[h]); check(token);
    if (res[h].verdict === 'failed') {
      draw.rejected.push(h); draw.log.push({handle:h,ok:false,reason:'Redraw: live second pass failed'});
      await publishDraw(draw); continue;
    }
    draw.discarded.push(handle); draw.slots[i] = h; draw.details[h] = res[h]; delete draw.details[handle];
    draw.log.push({handle:h,ok:true,reason:`Redraw replaced @${handle}`});
    await finishDraw(token,draw,`Redraw: @${handle} replaced by @${h}`);
    return;
  }
  await publishDraw(draw,{picking:false,status:`Redraw stopped after ${MAX_SECOND_PASS_ROUNDS} live checks; @${handle} kept.`});
}

// Cancel the job, abort content scans and close only the X tabs this job opened.
async function stop() {
  stopFlag = true; const old = job; job = null;
  if (old) {
    clearInterval(old.heartbeat);
    for (const pending of old.pending.values()) pending.reject(Error('Stopped.'));
    for (const id of old.tabs) {
      await chrome.tabs.sendMessage(id,{type:'ABORT'}).catch(() => {});
      await chrome.tabs.remove(id).catch(() => {});
    }
  }
  await patch({collecting:false,picking:false,ownedTabs:[],status:'Stopped. Saved completed pools and confirmed slots retained; ready.'});
}

// Reset: clear scrape results, winners, verification, draw and status. Giveaway rules (form) are kept.
async function reset() {
  if (job) throw Error('Stop the running job before Reset.');
  stopFlag = false;
  await chrome.storage.local.remove('zgWinners');
  await patch({eligible:[],buckets:{},winners:[],winnerChips:{},winnerDetails:{},draw:null,seed:null,verificationLog:[],
    diagnostics:{},followHints:{},collectedForm:null,coverage:null,sweepLog:null,ownedTabs:[],collecting:false,picking:false,
    status:'Reset. Collected data and winners cleared; rules kept. Ready to collect.'});
}

function launch(kind,body) {
  stopFlag = false;
  const token = {id:crypto.randomUUID(),tabs:new Set(),pending:new Map()}; job = token;
  // Periodic extension API calls keep the MV3 worker alive during long DOM scans.
  token.heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}),20000);
  const run = async () => {
    try {if (state.separateTab) await openPanel(); check(token); await body(token);}
    catch(e) {if (job===token) await patch({collecting:false,picking:false,status:`${e.message} Saved pools retained.`});}
    finally {clearInterval(token.heartbeat); if (job===token) {job=null; await patch({collecting:false,picking:false,ownedTabs:[]});}}
  };
  token.done = run(); return {ok:true};
}

async function start(kind,raw) {
  if (job) throw Error('Already running. Use Stop first.');
  const f = cleanForm(raw); postBase(f.postUrl);
  if (!f.requireLike && !f.requireComment && !f.requireRepostOrQuote) throw Error('Enable at least one engagement rule to create a candidate pool.');
  if (f.requireFollow && !f.followHandles.length) throw Error('Add at least one must-follow chip.');
  await patch({form:f,collecting:kind==='START',picking:kind==='PICK',status:'Starting…',
    ...(kind==='START' ? {eligible:[],buckets:{},winners:[],winnerChips:{},winnerDetails:{},draw:null,collectedForm:f,diagnostics:{},sweepLog:null,
      coverage:{state:'unavailable',error:'Collection did not finish; coverage not computed',rows:[],summary:'Coverage unavailable (collection did not finish).'}} : {})});
  if (kind==='START') await chrome.storage.local.remove('zgWinners');
  return launch(kind, token => kind==='START' ? collect(token,f) : pick(token,f));
}

async function startRedraw(handle) {
  if (job) throw Error('Already running. Use Stop first.');
  const h = norm(handle);
  if (!state.draw || !state.draw.slots.includes(h)) throw Error('Nothing to redraw: pick winners first.');
  await patch({picking:true,status:`Redrawing @${h}…`});
  return launch('REDRAW', token => redraw(token,h));
}

// Message router. Only extension pages may control jobs; X content scripts may only report scans.
chrome.runtime.onMessage.addListener((msg,sender,respond) => {
  if (sender.id !== chrome.runtime.id) return;
  const commands = ['GET_STATE','SAVE_FORM','SET_SETTINGS','OPEN_PANEL','START','STOP','PICK','REDRAW','RESET','DISMISS_LEGACY','PAGE_PROGRESS','PAGE_RESULT'];
  if (!commands.includes(msg?.type)) return;
  (async () => {
    await ready;
    if (sender.tab && !String(sender.url||'').startsWith(chrome.runtime.getURL('')) && !['PAGE_PROGRESS','PAGE_RESULT'].includes(msg.type)) throw Error('Untrusted command source.');
    if (msg.type==='GET_STATE') {await writeQueue; return {ok:true,state};}
    if (msg.type==='SAVE_FORM') {if (job) throw Error('Stop before editing rules.'); await patch({form:cleanForm(msg.form)});}
    if (msg.type==='SET_SETTINGS') {await patch({separateTab:!!msg.separateTab}); if (state.separateTab) await openPanel(true,true);}
    if (msg.type==='OPEN_PANEL') await openPanel(msg.focus!==false, msg.focus!==false);
    if (msg.type==='START'||msg.type==='PICK') return start(msg.type,msg.form);
    if (msg.type==='REDRAW') return startRedraw(msg.handle);
    if (msg.type==='STOP') await stop();
    if (msg.type==='RESET') await reset();
    if (msg.type==='DISMISS_LEGACY') await patch({legacyBonusHandles:[]});
    if (msg.type==='PAGE_RESULT' && job?.id===msg.jobId && job.tabs.has(sender.tab?.id)) job.pending.get(sender.tab.id)?.resolve(msg.result);
    if (msg.type==='PAGE_PROGRESS' && job?.id===msg.jobId && job.tabs.has(sender.tab?.id)) await patch({status:msg.text});
    return {ok:true};
  })().then(respond,e => respond({ok:false,error:e.message})); return true;
});

// A user-closed scan tab ends that step instead of waiting for the timeout.
chrome.tabs.onRemoved.addListener(id => {
  job?.pending.get(id)?.reject(Error('Collection tab was closed. Saved completed pools retained.'));
});
