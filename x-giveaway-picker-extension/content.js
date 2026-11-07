// vibe coded by @ZiggysGlizzy on X
/*
 * Content script on x.com / twitter.com pages. Reads handles from the rendered page and
 * scrolls the list. Only navigational controls (All replies / Show probable spam)
 * are ever clicked; never like, repost, follow or any other engagement button.
 */
(() => {
'use strict';
if (globalThis.__zgReader) return; globalThis.__zgReader = true;
let aborted = false;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const text = el => (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim().toLowerCase();
const visible = el => !!(el.getClientRects().length) && !el.closest('[aria-hidden="true"]');
function check() {if(aborted) throw Error('Stopped.');}
async function wait(ms) {for(let n=0;n<ms;n+=100) {check();await sleep(Math.min(100,ms-n));}check();}
function handle(a) {
  try {const u=new URL(a.getAttribute('href'),location.origin);
    if(!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(u.hostname)) return null;
    const m=u.pathname.match(/^\/([a-z0-9_]{1,15})\/?$/i);
    const skip=['home','explore','search','settings','i','messages','notifications','compose','login','signup','tos','privacy','jobs','about'];
    return m && !skip.includes(m[1].toLowerCase()) ? m[1].toLowerCase():null;
  } catch {return null;}
}
function primary() {return document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main') || document.body;}
// User lists may render in a modal; use a dialog only if it really holds user rows
// (an unrelated X sheet/banner dialog must not hijack reading or scrolling).
function listDialog() {return [...document.querySelectorAll('[role="dialog"]')].find(d=>d.querySelector('[data-testid="UserCell"]')) || null;}
function listRoot(mode) {return (['likes','retweets','following','followers'].includes(mode) && listDialog()) || primary();}
function readRows(mode,postId) {
  const root=listRoot(mode), entries=[];
  if(['quotes','replies'].includes(mode)) {
    for(const article of root.querySelectorAll('article[data-testid="tweet"]')) {
      // Only the outer tweet author, not a quoted tweet's author, mentions or sidebar accounts.
      const user=[...article.querySelectorAll('[data-testid="User-Name"]')].find(el=>!el.closest('[data-testid="quoteTweet"]'));
      if(!user) continue;
      const stamp=[...article.querySelectorAll('a[href*="/status/"]')].find(a=>a.querySelector('time'));
      if(mode==='replies' && stamp?.getAttribute('href')?.includes(`/status/${postId}`)) continue;
      const h=[...user.querySelectorAll('a[href]')].map(handle).find(Boolean);
      if(h) entries.push({h,row:article});
    }
  } else {
    for(const row of root.querySelectorAll('[data-testid="UserCell"]')) {
      // The first profile link is the account represented by this cell, not its bio mentions.
      const h=[...row.querySelectorAll('a[href]')].map(handle).find(Boolean);
      if(h) entries.push({h,row});
    }
  }
  return entries;
}
async function allReplies(diag) {
  const root=primary();
  const control=[...root.querySelectorAll('button,[role="button"],[role="tab"]')]
    .filter(visible).find(el=>/^(most )?relevant( replies)?$/.test(text(el)));
  if(control) {check();control.click();await wait(400);}
  const choices=[...document.querySelectorAll('[role="menuitem"],[role="option"],[role="tab"],button,[role="button"]')];
  const all=choices.filter(visible).find(el=>text(el)==='all replies' ||
    (text(el)==='all' && !!el.closest('[role="menu"],[role="listbox"]')));
  if(all) {check();all.click();diag.allRepliesClicked=true;await wait(500);}
}
function spam(diag,clicked) {
  const controls=[...primary().querySelectorAll('button,[role="button"],a[href],span')].filter(visible);
  let count=0;
  for(const el of controls) {
    if(el.closest('article[data-testid="tweet"]')) continue;
    if(!/^(show probable spam|show probably spam|show additional replies|show more replies|view hidden replies|show hidden replies)$/i.test(text(el))) continue;
    const target=el.closest('button,[role="button"],a[href]') || el;
    if(clicked.has(target)) continue;
    check();target.click();clicked.add(target);count++;diag.spamClicks++;
    diag.spamControlFound=true;
  }
  return count;
}
// The element that actually scrolls the list: the modal's scroll box, else the page itself.
function scroller() {
  const dialog=listDialog();
  if(dialog) {
    const box=[...dialog.querySelectorAll('div,section')].find(el=>el.scrollHeight>el.clientHeight+100 && el.clientHeight>100 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    if(box) return box;
  }
  return document.scrollingElement || document.documentElement;
}
// Advance one screen and nudge the last row into view so X's virtualized list loads more.
function scrollOnce(sc,rows) {
  sc.scrollBy({top:Math.max(400,Math.min(800,sc.clientHeight*.8)),behavior:'instant'});
  rows.at(-1)?.row.scrollIntoView({block:'end',behavior:'instant'});
}
// Collection: 3s bottom settle plus a height-independent row-growth backup.
// Spinner/virtualization height changes never reset the no-new-accounts counter.
// Verification scans (opts.want) do not use these collection-only stops.
const BOTTOM_SETTLE_MS = 3000;   // at the bottom with no new rows for this long = list finished
const NO_GROWTH_ROUNDS = 8;      // backup: this many scrolls in a row with no new accounts = finished
const isAtBottom = sc => sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8;
/*
 * Scroll-and-read loop. Ends when every wanted handle is found (verification early stop),
 * after maxIdle rounds with no growth or movement, or at the round cap. Collection scans
 * also end once the bottom is reached and no new rows arrive for BOTTOM_SETTLE_MS, or after
 * NO_GROWTH_ROUNDS scrolls with no new accounts. At least one real scroll always happens
 * first, so a list is never judged from its top rows alone.
 */
async function collect(mode,opts) {
  const all=new Set(), seen=new Set(), hints={}, clicked=new Set();
  const want=opts.want ? new Set(opts.want):null;
  const diag={spamClicks:0,spamControlFound:false,allRepliesClicked:false,capped:false,endReason:'idle',rounds:0,scrolls:0};
  if(mode==='replies' && opts.preferAllReplies) await allReplies(diag);
  // Give X up to ~10 s to render the first rows before counting idle rounds.
  for(let n=0;n<20 && !readRows(mode,opts.postId).length;n++) await wait(500);
  let idle=0,last='',round=0,lastSeen=0,noGrowth=0,bottomSince=0;
  const max=opts.maxRounds||1500, maxIdle=opts.maxIdleRounds||18;
  for(;round<max;round++) {
    check();let clicks=0;
    if(mode==='replies' && opts.preferAllReplies && !diag.allRepliesClicked && round<4) await allReplies(diag);
    if(mode==='replies' && opts.includeProbableSpam) clicks=spam(diag,clicked);
    if(clicks) {await wait(900);
      diag.spamExpansionObserved = diag.spamExpansionObserved || [...clicked]
        .some(el=>!el.isConnected || !visible(el) || !text(el).includes('spam'));
    }
    const rows=readRows(mode,opts.postId);
    for(const {h,row} of rows) {
      seen.add(h);
      if(!want || want.has(h)) all.add(h);
      // 'Follows you' is relative to the logged-in account only. NEVER treat a Follow/Following
      // button (the viewer's outbound relationship) as proof of following a required handle.
      if(/\bfollows you\b/i.test(text(row))) hints[h]={followsViewer:true};
    }
    diag.rounds=round+1;
    const scrolled=diag.scrolls>0;
    if(scrolled && want?.size && [...want].every(h=>all.has(h))) {diag.endReason='targets-found';break;}
    const sc=scroller();
    const signature=`${seen.size}:${sc.scrollHeight}:${Math.round(sc.scrollTop)}`;
    idle=signature===last && !clicks ? idle+1:0;last=signature;
    if(round%3===0) chrome.runtime.sendMessage({type:'PAGE_PROGRESS',jobId:opts.jobId,
      text:`${opts.progressLabel || `Reading ${mode}`}: ${want ? `${all.size}/${want.size} required found · ${seen.size} rows` : `${all.size} accounts`} · round ${round+1}${mode==='replies' ? ` · spam controls clicked ${diag.spamClicks}`:''}`}).catch(()=>{});
    if(scrolled && idle>=maxIdle) break;
    // Collection only: finish promptly at the end of the list instead of idling.
    let bottom=false;
    if(!want) {
      const grew=seen.size>lastSeen || clicks>0;lastSeen=seen.size;
      bottom=isAtBottom(sc);
      noGrowth=grew ? 0 : noGrowth+1;
      diag.noGrowthRounds=noGrowth; // independent of height/position jiggle
      bottomSince=grew || !bottom ? 0 : (bottomSince || Date.now());
      if(scrolled && bottomSince && Date.now()-bottomSince>=BOTTOM_SETTLE_MS) {diag.endReason='bottom-reached';break;}
      if(scrolled && noGrowth>=NO_GROWTH_ROUNDS) {diag.endReason='no-new-rows';break;}
    }
    scrollOnce(sc,rows);diag.scrolls++;
    await wait(bottom ? 500 : 1000); // poll faster while settling at the bottom
  }
  if(round>=max) {diag.capped=true;diag.endReason='safety-cap';}
  diag.rowsSeen=seen.size; // 0 rows = list empty/unavailable (V1.0 second pass treats as inconclusive)
  return {ok:true,handles:[...all],followHints:hints,diagnostics:diag};
}
// Only a badge in the profile header counts. Timeline text/bios and outbound buttons do not.
async function profileFollow(opts) {
  for(let n=0;n<20;n++) {
    check();
    const name=primary().querySelector('[data-testid="UserName"]');
    const badge=primary().querySelector('[data-testid="UserFollowIndicator"]');
    const viewer=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const candidate=location.pathname.match(/^\/([a-z0-9_]{1,15})\/?$/i)?.[1].toLowerCase();
    const followsViewer=candidate===opts.candidate && !!name && !!badge && visible(badge) &&
      !badge.closest('article,[data-testid="UserCell"],[data-testid="UserDescription"]') && text(badge)==='follows you';
    if(followsViewer && viewer) return {ok:true,handles:[],followsViewer:true,viewerHandle:handle(viewer)};
    await wait(500);
  }
  const viewer=document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  return {ok:true,handles:[],followsViewer:false,viewerHandle:viewer?handle(viewer):null};
}
// ---- Public totals on the ORIGINAL post (coverage estimate only; never affects the draw) ----
// Language-independent first: data-testid controls and /status/{id}/retweets|quotes hrefs.
// Numbers: non-Latin digits, locale grouping/decimals, bounded abbreviation list.
// No number = unavailable (never 0) unless a recognized empty stat control proves a hidden zero.
const DIGIT_ZEROS=[0x30,0x660,0x6F0,0x7C0,0x966,0x9E6,0xA66,0xAE6,0xB66,0xBE6,0xC66,0xCE6,0xD66,0xE50,0xED0,0xF20,0x1040,0x17E0,0x1810,0xFF10];
function latinDigits(s) {
  return String(s||'').replace(/\p{Nd}/gu,ch=>{const cp=ch.codePointAt(0);
    const z=DIGIT_ZEROS.find(z=>cp>=z&&cp<z+10);return z==null?ch:String(cp-z);});
}
// Bounded abbreviation suffixes (en, es/pt, de, fr, it, nl, ru, ja/zh, ko, tr, id).
const SUFFIX={k:1e3,m:1e6,b:1e9,mil:1e3,'mi':1e6,'mio':1e6,'mrd':1e9,'md':1e9,'mln':1e6,'mld':1e9,'tsd':1e3,'rb':1e3,'jt':1e6,
  'тыс':1e3,'млн':1e6,'млрд':1e9,'万':1e4,'萬':1e4,'億':1e8,'亿':1e8,'千':1e3,'천':1e3,'만':1e4,'억':1e8,'bin':1e3,'mn':1e6};
const SEP='[.,\\u00a0\\u202f\\u2009 \'’٬٫]';
const NUM_RE=new RegExp(`(\\d(?:${SEP}?\\d)*)\\s*(${Object.keys(SUFFIX).sort((a,b)=>b.length-a.length).map(s=>s.replace('.','\\.')).join('|')})?(?![\\p{L}\\d])`,'iu');
function localeSeps() {
  try {const lang=document.documentElement.lang||navigator.language||'en';
    const parts=new Intl.NumberFormat(lang).formatToParts(12345.6);
    return {group:parts.find(p=>p.type==='group')?.value||',',decimal:parts.find(p=>p.type==='decimal')?.value||'.'};}
  catch {return {group:',',decimal:'.'};}
}
/*
 * Parse the first count in a string. Returns {value, approx} or {ambiguous:true} or null.
 * - Abbreviated (K/M/mil/万…): the last separator with 1–2 trailing digits is the decimal; approx.
 * - Plain: separators must split into 3-digit groups (1,234 / 1.234 / 1 234 / 1 234) => exact.
 *   Anything else (e.g. "1,5" with no suffix) is ambiguous: not a whole count => unavailable.
 */
function parseCount(str) {
  const m=latinDigits(str).match(NUM_RE);
  if(!m) return null;
  const token=m[1], suffix=(m[2]||'').toLowerCase(), mult=suffix?SUFFIX[suffix]:1;
  const seps=token.match(new RegExp(SEP,'g'))||[];
  if(!seps.length) return {value:Number(token)*mult,approx:mult>1};
  const groups=token.split(new RegExp(SEP));
  if(mult>1) {
    const last=groups.at(-1);
    if(last.length<=2) {const int=groups.slice(0,-1).join('');return {value:Math.round(Number(`${int}.${last}`)*mult),approx:true};}
    if(groups.slice(1).every(g=>g.length===3)) return {value:Number(groups.join(''))*mult,approx:true};
    return {ambiguous:true};
  }
  const {decimal}=localeSeps();
  if(groups.slice(1).every(g=>g.length===3) && groups[0].length<=3 && new Set(seps).size===1) return {value:Number(groups.join('')),approx:false,
    note: seps[0]===decimal ? 'grouping (counts are whole numbers)' : ''};
  return {ambiguous:true};
}
// Bounded localized words for the stats-group label fallback (language-independent paths come first).
const WORDS={
  likes:'likes?|me gusta|curtidas?|gefällt mir|j[’\']aime|mi piace|vind ik leuk|beğeni|いいね|喜欢|喜歡|좋아요|отметк[аи]? «нравится»|suka',
  reposts:'reposts?|retweets?|reposts?|reenvíos|reposts|republicaciones|repostagens|retweets|reposts|リポスト|转帖|轉發|재게시|репост(?:а|ов)?',
  replies:'repl(?:y|ies)|respuestas?|respostas?|antworten|réponses?|risposte|antwoorden|yanıt|返信|回复|回覆|답글|ответ(?:а|ов)?|balasan'};
function labelled(str,word) {
  const s=latinDigits(String(str||''));
  const re=new RegExp(`(\\d(?:${SEP}?\\d)*(?:\\s*[\\p{L}]{1,4}\\.?)?)\\s+(?:${word})(?![\\p{L}])`,'iu');
  const m=s.match(re);return m?parseCount(m[1]):null;
}
const CONTAINERS='article[data-testid="tweet"],article,[role="article"],[data-testid="tweet"]';
const STATUS_PATH=/^\/([a-z0-9_]{1,15}|i\/web|i)\/status\/(\d+)(?:\/(?:video|photo)\/\d+|\/analytics)?\/?$/i;
const isNested=(el,container)=>{const own=el.closest(CONTAINERS);return (own&&own!==container) || !!el.closest('[data-testid="quoteTweet"]');};
const inOwn=(container,sel)=>[...container.querySelectorAll(sel)].filter(el=>!isNested(el,container));
/*
 * Original post container: the outermost post container whose OWN (not nested/quoted) timestamp
 * or permalink points at /status/{id} (also /i/status/{id} and /video/1 or /photo/1 forms used by
 * media/video layouts). Author must match, unless exactly one container matches the status ID
 * (renamed account). Searches the main column first, then any open media/video viewer dialog.
 */
function originalArticle(postId,author) {
  const roots=[primary(),...document.querySelectorAll('[role="dialog"]')];
  const hits=[];
  for(const root of roots) for(const c of root.querySelectorAll(CONTAINERS)) {
    if(hits.some(h=>h.c===c) || c.closest('[data-testid="quoteTweet"]')) continue;
    const parent=c.parentElement?.closest(CONTAINERS); if(parent && parent!==c) continue; // nested inside another post
    for(const a of inOwn(c,'a[href*="/status/"]')) {
      let u;try {u=new URL(a.getAttribute('href'),location.origin);} catch {continue;}
      const m=u.pathname.match(STATUS_PATH);
      if(!m||m[2]!==String(postId)) continue;
      const strong=!!a.querySelector('time'); const who=m[1].toLowerCase();
      hits.push({c,strong,authorOk:!author||who===author,generic:who==='i'||who==='i/web'});
      break;
    }
  }
  const ok=hits.filter(h=>h.authorOk||h.generic);
  const pick=(ok.find(h=>h.strong)||ok[0]);
  if(pick) return pick.c;
  return hits.length===1 ? hits[0].c : null;   // renamed author: accept only a unique match
}
// One stat control (reply/like) counted language-independently.
function controlCount(container,ids,name) {
  const el=ids.map(id=>inOwn(container,`[data-testid="${id}"]`)[0]).find(Boolean);
  if(!el) return {value:null,reason:`${name} control not found`};
  const t=parseCount(text(el));
  if(t&&!t.ambiguous) return {...t,source:`${name} control text`};
  const a=parseCount(el.getAttribute('aria-label')||'');
  if(a&&!a.ambiguous) return {...a,source:`${name} control label`};
  if(t?.ambiguous||a?.ambiguous) return {value:null,reason:`${name} count could not be parsed safely`};
  // Hidden zero only from known markup: rendered control, its count slot present but empty, label has no digits.
  const slot=el.querySelector('[data-testid="app-text-transition-container"]');
  const label=el.getAttribute('aria-label');
  if(slot && !text(slot) && label!=null && !/\p{Nd}/u.test(label) && el.getClientRects().length)
    return {value:0,approx:false,inferred:true,source:`${name} control empty (hidden 0, inferred)`};
  return {value:null,reason:`${name} count not shown (unknown, not assumed 0)`};
}
// Reposts / Quotes from the post's OWN labelled detail links (href-based, any language). No hidden-zero guess.
function linkCount(container,postId,suffix,name) {
  const a=inOwn(container,'a[href]').find(a=>{try {return new URL(a.getAttribute('href'),location.origin).pathname.toLowerCase().replace(/\/$/,'').endsWith(`/status/${postId}/${suffix}`);} catch {return false;}});
  if(!a) return {value:null,reason:`${name} link not shown on the post`};
  const n=parseCount(text(a)) || parseCount(a.getAttribute('aria-label')||'');
  if(n&&!n.ambiguous) return {...n,source:`${name} link`};
  return {value:null,reason:n?.ambiguous?`${name} count could not be parsed safely`:`${name} link shows no number (unknown)`};
}
function readCounts(container,postId) {
  const group=inOwn(container,'[role="group"][aria-label]').map(g=>g.getAttribute('aria-label')).join(' ');
  const withGroup=(r,word,name)=>{ if(r.value!=null && !r.inferred) return r;
    const g=labelled(group,word); if(g&&!g.ambiguous) return {...g,source:`${name} in stats label`};
    return r; };
  const likes=withGroup(controlCount(container,['like','unlike'],'like'),WORDS.likes,'likes');
  const replies=withGroup(controlCount(container,['reply'],'reply'),WORDS.replies,'replies');
  const reposts=linkCount(container,postId,'retweets','Reposts');
  const quotes=linkCount(container,postId,'quotes','Quotes');
  const rb=controlCount(container,['retweet','unretweet'],'repost');
  const rbg=rb.value!=null&&!rb.inferred?rb:(()=>{const g=labelled(group,WORDS.reposts);return g&&!g.ambiguous?{...g,source:'reposts in stats label'}:null;})();
  return {likes,replies,reposts,quotes,repostButton:rbg};
}
// Better reading: an explicit number beats an inferred zero beats unknown.
const rank=r=>r?.value==null?0:r.inferred?1:2;
/*
 * Find the original post, then read totals; re-read up to opts.retries times (opts.retryMs apart)
 * for late hydration, keeping the best value found per total. Inferred zeros are only kept after
 * the last attempt still shows the empty control. Cancel-safe via wait()/check().
 */
async function postCounts(opts) {
  let article=null;
  for(let n=0;n<20 && !article;n++) {check();article=originalArticle(opts.postId,opts.author);if(!article) await wait(500);}
  if(!article) return {ok:true,found:false,handles:[],counts:null};
  const retries=opts.retries??4, gap=opts.retryMs??1500, keys=['likes','replies','reposts','quotes','repostButton'];
  let best={}, attempts=0;
  for(let i=0;i<=retries;i++) {
    check(); attempts++;
    const c=originalArticle(opts.postId,opts.author) || article; article=c;
    const now=readCounts(c,opts.postId);
    for(const k of keys) if(rank(now[k])>rank(best[k]) || (!best[k]&&now[k])) best[k]=now[k];
    const need=(opts.need||keys).filter(k=>k!=='repostButton');
    if(need.every(k=>rank(best[k])===2)) break;
    if(i<retries) await wait(gap);
  }
  const counts={}, reasons={};
  for(const k of keys) {
    const r=best[k];
    if(r?.value!=null) counts[k]={value:r.value,approx:!!r.approx,inferred:!!r.inferred,source:r.source};
    else {counts[k]=null; if(r?.reason) reasons[k]=r.reason;}
  }
  return {ok:true,found:true,handles:[],counts,reasons,attempts};
}
async function scan(mode,opts) {
  if(mode==='postCounts') return postCounts(opts);
  if(mode==='profileFollow') return profileFollow(opts);
  return collect(mode,opts);
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id) return;
  if(msg?.type==='PING') {reply({ok:true});return;}
  if(msg?.type==='ABORT') {aborted=true;reply({ok:true});return;}
  if(msg?.type==='COLLECT_PAGE') {aborted=false;
    reply({ok:true,started:true});
    const finish = result => chrome.runtime.sendMessage({type:'PAGE_RESULT',jobId:msg.options?.jobId,result}).catch(()=>{});
    (async()=>{await wait(1200);return scan(msg.mode,msg.options||{});})()
      .then(finish,e=>finish({ok:false,error:e.message}));
  }
});
})();
