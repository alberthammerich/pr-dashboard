const REPO_URL = "https://github.com/alberthammerich/pr-dashboard";
const SRC = REPO_URL.replace("https://github.com/","");
const LS = { token:"prdash_token", refresh:"prdash_refresh", exp:"prdash_exp", author:"prdash_author", hours:"prdash_hours", me:"prdash_me", bg:"prdash_bg", db:"prdash_db" };
const HOURS_DEFAULT = 48;
// "Sign in with GitHub": empty clientId hides the button. Only works on the origin the OAuth App's callback is registered for,
// so self-deployed copies fall back to pasting a token.
const OAUTH = { clientId:"Ov23liqusWyO1KYoKEr9", exchange:"https://pr-dashboard-auth.albertbrovsing.workers.dev/", home:"https://alberthammerich.github.io/pr-dashboard/" };
const oauthReady = () => !!(OAUTH.clientId && OAUTH.exchange && location.href.startsWith(OAUTH.home));
const WAITLIST_URL = REPO_URL+"/issues/2", SPONSOR_URL = "https://github.com/sponsors/alberthammerich";

const get = (k, d) => localStorage.getItem(k) ?? d;
const $ = id => document.getElementById(id);
function applyTheme(){
  if(!ME) $("favicon").href = "assets/alberthammerich-avatar.png";
}

let DB = null, ME = null, activeFilter = "all", autoTimer = null;
const ICON = { pass:"✓", fail:"×", running:"◌", skip:"–", none:"·", other:"·" };
const CIICON = { pass:"✓", fail:"×", running:"◌", none:"·" };
const TREE_GRAPH = `<div class="tree-graph" role="img" aria-label="A pine drawn in ASCII: the trunk is main and each branch is a pull request, marked with its CI status"><canvas id="tree"></canvas></div>`;
function rel(iso){ if(!iso) return ""; const d=(Date.now()-new Date(iso).getTime())/1000,m=60,h=3600,day=86400;
  if(d<0) return "just now"; if(d<m) return Math.floor(d)+"s ago"; if(d<h) return Math.floor(d/m)+"m ago"; if(d<day) return Math.floor(d/h)+"h ago"; return Math.floor(d/day)+"d ago"; }
const safeUrl = u => /^https:\/\//i.test(u||"") ? u : ""; // links come from third-party CI apps; never allow javascript: etc.
function esc(s){ return (s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- GitHub REST ---------- */
// OAuth tokens expire after 8h; renew via the relay. One shared promise, since refresh tokens are single-use.
let refreshing = null;
async function freshToken(){
  const rt=get(LS.refresh,""), exp=Number(get(LS.exp,0));
  if(rt && Date.now() > exp-5*60000) await (refreshing ||= oauthExchange({refresh_token:rt}).finally(()=>{ refreshing=null; }));
  return get(LS.token,"");
}
async function oauthExchange(body){
  const r=await fetch(OAUTH.exchange, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
  const j=await r.json();
  if(!j.access_token) throw new Error("GitHub sign-in failed ("+(j.error||r.status)+"). Please sign in again.");
  localStorage.setItem(LS.token, j.access_token);
  if(j.refresh_token){ localStorage.setItem(LS.refresh, j.refresh_token); localStorage.setItem(LS.exp, String(Date.now()+j.expires_in*1000)); }
  else { localStorage.removeItem(LS.refresh); localStorage.removeItem(LS.exp); }
}
async function api(path, body){
  const token = await freshToken();
  return fetch("https://api.github.com"+path, { method:body?"POST":"GET", body:body?JSON.stringify(body):undefined, headers:{ "Authorization":"Bearer "+token, "Accept":"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" }, cache:"no-store" })
  .then(async r=>{
    if(r.status===401) throw new Error("GitHub didn’t accept that token (401). Sign in again.");
    if(r.status===403){ const b=await r.text(); throw new Error("GitHub said no (403). "+(b.includes("rate")?"You’ve hit the rate limit. Give it a minute.":"Your token may be missing the repo scope.")); }
    if(!r.ok) throw new Error("GitHub returned "+r.status+".");
    return r.json();
  });
}
function normChecks(runs, statuses){
  const out=[];
  for(const c of (runs||[])){
    let status;
    if((c.status||"").toUpperCase()!=="COMPLETED") status="running";
    else { const k=(c.conclusion||"").toUpperCase(); status = k==="SUCCESS"?"pass" : (k==="NEUTRAL"||k==="SKIPPED")?"skip" : "fail"; }
    out.push({ status, name:c.name||"check", workflow:(c.app&&c.app.name)||"", url:c.details_url||c.html_url||"" });
  }
  for(const s of (statuses||[])){
    const k=(s.state||"").toUpperCase();
    const status = k==="SUCCESS"?"pass" : k==="PENDING"?"running" : (k==="FAILURE"||k==="ERROR")?"fail":"other";
    out.push({ status, name:s.context||"status", workflow:"", url:s.target_url||"" });
  }
  return out;
}
function rollup(checks){ if(!checks.length) return "none";
  if(checks.some(c=>c.status==="fail")) return "fail"; if(checks.some(c=>c.status==="running")) return "running";
  if(checks.some(c=>c.status==="pass")) return "pass"; return "none"; }
// One GraphQL search returns each PR with its CI, instead of 3 REST calls per PR.
const PR_QUERY=`query($q:String!){ search(query:$q, type:ISSUE, first:100){ nodes{ ... on PullRequest{
  number title url state isDraft additions deletions createdAt updatedAt closedAt headRefName
  repository{nameWithOwner} comments{totalCount} reviewRequests{totalCount}
  commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{ __typename
    ... on CheckRun{ name status conclusion detailsUrl checkSuite{ app{ name } } }
    ... on StatusContext{ context state targetUrl } } } } } } } } } } }`;
async function searchPRs(q){
  const j=await api("/graphql", {query:PR_QUERY, variables:{q}});
  if(j.errors) throw new Error("GitHub returned an error: "+j.errors.map(e=>e.message).join("; "));
  return j.data.search.nodes;
}
function toPR(n){
  const c=n.commits.nodes[0], ctx=(c&&c.commit.statusCheckRollup&&c.commit.statusCheckRollup.contexts.nodes)||[];
  const checks=normChecks(
    ctx.filter(x=>x.__typename==="CheckRun").map(x=>({ name:x.name, status:x.status, conclusion:x.conclusion, details_url:x.detailsUrl, app:x.checkSuite&&x.checkSuite.app })),
    ctx.filter(x=>x.__typename==="StatusContext").map(x=>({ context:x.context, state:x.state, target_url:x.targetUrl })));
  return { number:n.number, title:n.title, url:n.url, repo:n.repository.nameWithOwner, state:n.state, isDraft:n.isDraft,
    reviewDecision:n.reviewRequests.totalCount?"REVIEW_REQUIRED":"", branch:n.headRefName, additions:n.additions, deletions:n.deletions,
    comments:n.comments.totalCount, createdAt:n.createdAt, updatedAt:n.updatedAt, closedAt:n.closedAt, ci:rollup(checks), checks };
}
async function collect(){
  const author = get(LS.author, "") || (ME && ME.login);
  const hours = Number(get(LS.hours, HOURS_DEFAULT));
  const cutoff = Date.now() - hours*3600*1000;
  const sinceDay = new Date(cutoff).toISOString().slice(0,10);
  const [open, closed] = await Promise.all([
    searchPRs(`author:${author} type:pr state:open sort:updated-desc`),
    searchPRs(`author:${author} type:pr state:closed closed:>=${sinceDay} sort:updated-desc`),
  ]);
  const recentClosed = closed.filter(p=>p.closedAt && new Date(p.closedAt).getTime()>=cutoff);
  return { prs:[...open, ...recentClosed].map(toPR), generatedAt:new Date().toISOString(), author, hours };
}

/* ---------- render dashboard ---------- */
function stateBadge(pr){ if(pr.state==="MERGED")return '<span class="badge b-merged">merged</span>';
  if(pr.state==="CLOSED")return '<span class="badge b-closed">closed</span>';
  if(pr.isDraft)return '<span class="badge b-draft">draft</span>'; return '<span class="badge b-open">open</span>'; }
function reviewBadge(pr){ return (pr.state==="OPEN"&&pr.reviewDecision==="REVIEW_REQUIRED")?'<span class="badge b-review">needs review</span>':""; }
function matches(pr, term){
  if(activeFilter==="open"&&pr.state!=="OPEN") return false;
  if(activeFilter==="closed"&&pr.state==="OPEN") return false;
  if(activeFilter==="failing"&&pr.ci!=="fail") return false;
  if(activeFilter==="running"&&pr.ci!=="running") return false;
  if(!term) return true;
  const hay=(pr.title+" "+pr.repo+" "+pr.branch+" #"+pr.number).toLowerCase();
  return term.split(/\s+/).every(t=>hay.includes(t));
}
function statcard(n,label,color){ return '<div class="statcard"><div class="n" style="color:'+color+'">'+n+'</div><div class="l">'+label+'</div></div>'; }
function statsStrip(){
  const o=DB.prs.filter(p=>p.state==="OPEN").length;
  const c=DB.prs.length-o;
  const fail=DB.prs.filter(p=>p.ci==="fail").length;
  const run=DB.prs.filter(p=>p.ci==="running").length;
  return '<div class="stats">'
    + statcard(o,"open", o?"var(--accent-ink)":"var(--faint)")
    + statcard(c,"closed · "+DB.hours+"h", c?"var(--merged)":"var(--faint)")
    + statcard(fail,"ci failing", fail?"var(--fail)":"var(--faint)")
    + statcard(run,"running", run?"var(--run)":"var(--faint)")
    + '</div>';
}
function render(){
  if(!DB) return;
  const term=$("q").value.trim().toLowerCase();
  const main=$("main"); const byRepo={}; let shown=0;
  for(const pr of DB.prs){ if(!matches(pr,term)) continue; (byRepo[pr.repo]||=[]).push(pr); shown++; }
  const repos=Object.keys(byRepo).sort();
  main.innerHTML=statsStrip();
  if(!repos.length){ main.insertAdjacentHTML("beforeend",'<div class="empty">Nothing matches that filter.</div>'); updateCounts(0); return; }
  const expandFail=!!term||activeFilter!=="all";
  for(const repo of repos){
    const list=byRepo[repo].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
    const fail=list.filter(p=>p.ci==="fail").length, run=list.filter(p=>p.ci==="running").length;
    const d=document.createElement("details"); d.className="repo"; d.open=true;
    let badges=""; if(fail)badges+='<span class="repo-alert fail">'+fail+' failing</span>'; if(run)badges+='<span class="repo-alert run">'+run+' running</span>';
    d.innerHTML='<summary><span class="rname">'+esc(repo)+'</span> <span class="repo-count">'+list.length+'</span><span class="repo-badges">'+badges+'</span></summary>';
    for(const pr of list){
      const pd=document.createElement("details"); pd.className="pr"; pd.open=expandFail&&(pr.ci==="fail"||activeFilter==="failing");
      let checksHtml;
      if(!pr.checks.length){ checksHtml='<div class="none">No CI checks on this one.</div>'; }
      else { const order={fail:0,running:1,pass:2,skip:3,other:4};
        checksHtml=pr.checks.slice().sort((a,b)=>(order[a.status]??9)-(order[b.status]??9)).map(c=>
          '<div class="check"><span class="check-mark '+esc(c.status)+'">'+(ICON[c.status]||"·")+'</span>'
          +(safeUrl(c.url)?'<a href="'+esc(c.url)+'" target="_blank" rel="noopener">'+esc(c.name)+'</a>':esc(c.name))
          +(c.workflow?' <span class="wf">· '+esc(c.workflow)+'</span>':'')+'</div>').join(""); }
      const stats=(pr.additions!=null)?'<span class="stat">+'+pr.additions+' −'+pr.deletions+'</span>':'';
      pd.innerHTML='<summary><span class="ci-dot ci-'+esc(pr.ci)+'" title="CI: '+pr.ci+'">'+(CIICON[pr.ci]||"·")+'</span>'
        +'<a class="pr-title" href="'+esc(safeUrl(pr.url))+'" target="_blank" rel="noopener">'+esc(pr.title)+'</a>'
        +'<span class="pr-num">#'+pr.number+(pr.branch?' · '+esc(pr.branch):'')+'</span>'
        +stateBadge(pr)+reviewBadge(pr)+'<span class="spacer"></span>'+stats
        +'<span class="when">'+rel(pr.state==="OPEN"?pr.updatedAt:pr.closedAt)+'</span></summary>'
        +'<div class="checks">'+checksHtml+'</div>';
      d.appendChild(pd);
    }
    main.appendChild(d);
  }
  main.insertAdjacentHTML("beforeend",'<div class="foot"><a href="'+WAITLIST_URL+'" target="_blank" rel="noopener">Want CI alerts in Slack or email? 👍 here</a> · <a href="'+SPONSOR_URL+'" target="_blank" rel="noopener">Sponsor ♥</a></div>');
  updateCounts(shown);
}
function updateCounts(shown){
  if(!DB){ $("counts").textContent=""; return; }
  const t=DB.prs.length;
  $("counts").innerHTML="showing <b>"+shown+"</b> of "+t;
  $("brandSub").textContent="open + closed in "+DB.hours+"h · refreshed "+rel(DB.generatedAt);
}

/* ---------- landing ---------- */
function showLanding(errMsg){
  document.body.classList.remove("app");
  $("brandBox").classList.remove("hide"); $("brandAvatar").classList.add("hide");
  $("brandName").innerHTML="pr&middot;dashboard"; $("brandSub").textContent="the PRs you're working on, with their CI";
  $("refresh").classList.add("hide"); $("autoWrap").classList.add("hide"); $("settings").classList.add("hide");
  $("controls").classList.add("hide"); $("srcLink").classList.remove("hide");
  $("main").innerHTML =
    '<div class="landing">'
    +'<section class="landing-stage rise">'
      +'<div class="landing-meta"><span class="bg-switch" role="group" aria-label="Background">'+BG_BUTTONS+'</span><span class="pass">[+] pass</span><span class="fail">[x] fail</span><span class="run">[~] running</span></div>'
      +'<div class="landing-bottom">'
      +'<div class="landing-copy"><span class="kicker">PR dashboard / browser-local</span>'
        +'<h1>One view from branch<br>to merge.</h1>'
        +'<p><b>Open work, recent closes, live CI.</b> Grouped by repository and kept close without adding another service to the stack.</p>'
      +'</div>'
      +'<div class="connect">'+TREE_GRAPH
      +(oauthReady()?'<button class="btn primary gh-signin" id="ghSignIn"><svg class="gh-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg><span>Sign in with GitHub<small>Install as third-party app</small></span></button>'
        +'<div class="help gh-note">Work org shows “Request”? Its admin has to approve the app. Paste a token below to skip that.</div>'
        +'<span class="lbl or">or paste a token</span>':'<span class="lbl">Paste a token</span>')
      +'<div class="help gh-cli">Have the GitHub CLI? Run <code>gh auth token | pbcopy</code> <button type="button" class="copy" id="copyGh">copy</button> and paste. Works with SSO orgs, no approval needed.</div>'
      +'<div class="row">'
      +'<input id="tok" type="password" placeholder="Paste token" autocomplete="off" aria-label="GitHub personal access token" />'
      +'<button class="btn primary" id="connect">Open dashboard</button>'
      +'</div><button class="btn deploy-link" id="deploy">or deploy your own copy --&gt;</button>'
      +'<div class="help">The token is stored only in this browser and sent directly to GitHub. Use <code>repo</code> scope for private repositories; public-only tokens need no scope.</div>'
      +'<div class="err" id="lerr">'+(errMsg?esc(errMsg):"")+'</div><div class="dstatus" id="dstatus"></div>'
      +'</div>'
      +'</div>'
    +'</section>'
    +'<section class="started">'
      +'<h2>'+(oauthReady()?'No GitHub CLI? <i>A token takes a minute.</i>':'Up and running <i>in a minute.</i>')+'</h2>'
      +'<ol class="gitsteps">'
        +'<li><span class="no">01 / token</span><b>Create a token</b><span class="d">At <a href="https://github.com/settings/tokens/new?scopes=repo&description=PR%20Dashboard" target="_blank" rel="noopener">GitHub settings</a>. Add <code>repo</code> only if you need private repositories.</span></li>'
        +'<li><span class="no">02 / sso</span><b>Authorize your org</b><span class="d">If your organization uses SSO, choose <b>Configure SSO</b> next to the token and grant access.</span></li>'
        +'<li><span class="no">03 / connect</span><b>Paste it once</b><span class="d">This browser remembers it. Signing out wipes it.</span></li>'
      +'</ol>'
      +'<ul class="facts">'
        +'<li><b>No server in the middle</b>A static page that talks only to <code>api.github.com</code>. Sign in with GitHub passes once through a tiny open-source relay that stores and logs nothing.</li>'
        +'<li><b>Token stays here</b>Kept in this browser and sent to no one but GitHub.</li>'
        +'<li><b>One open file</b>No dependencies, no analytics. <a id="srcLink2" href="#" target="_blank" rel="noopener">Read it.</a></li>'
        +'<li><b>Read-only</b>It never writes to your repositories.</li>'
      +'</ul>'
    +'</section>'
    +'<div class="foot">A small, open-source desk for the stretch between push and merge. <a id="srcLink3" href="#" target="_blank" rel="noopener">Read the code ↗</a></div></div>';
  ["srcLink","srcLink2","srcLink3"].forEach(id=>{ const el=$(id); if(el) el.href=REPO_URL; });
  const go=()=>{ const tv=$("tok").value.trim(); if(!tv){ $("lerr").textContent="Paste your token first."; return; } localStorage.setItem(LS.token, tv); localStorage.removeItem(LS.refresh); localStorage.removeItem(LS.exp); connectAndLoad(); };
  $("connect").onclick=go; $("deploy").onclick=deployFlow;
  if($("ghSignIn")) $("ghSignIn").onclick=oauthStart;
  $("copyGh").onclick=e=>navigator.clipboard.writeText("gh auth token | pbcopy").then(()=>{ e.target.textContent="copied ✓"; });
  $("tok").addEventListener("keydown", e=>{ if(e.key==="Enter") go(); });
  $("tok").focus({preventScroll:true});
  wireBgSwitch();
  initTree($("tree"));
  window.scrollTo(0,0);
}

/* ---------- Sign in with GitHub (OAuth web flow) ---------- */
function oauthStart(){
  const state=crypto.randomUUID(); sessionStorage.setItem("prdash_oauth_state", state);
  location.href="https://github.com/login/oauth/authorize?"+new URLSearchParams({ client_id:OAUTH.clientId, scope:"repo", state, redirect_uri:OAUTH.home });
}
// GitHub redirects back with ?code&state. Returns true when it handled a callback.
async function oauthFinish(){
  const p=new URLSearchParams(location.search), code=p.get("code"), state=p.get("state");
  if(!code&&!p.get("error")) return false;
  history.replaceState(null,"",location.pathname);
  const expected=sessionStorage.getItem("prdash_oauth_state"); sessionStorage.removeItem("prdash_oauth_state");
  if(p.get("error")){ showLanding("GitHub sign-in was cancelled."); return true; }
  if(!expected||state!==expected){ showLanding("Sign-in check failed. Please try again."); return true; }
  studyShow("Signing you in");
  try{
    await oauthExchange({code}); connectAndLoad();
  }catch(e){ studyHide(); showLanding(String(e.message||e)); }
  return true;
}

/* ---------- settings ---------- */
function showSettings(){
  const author=get(LS.author,"")||(ME&&ME.login)||"", hours=get(LS.hours,HOURS_DEFAULT);
  $("main").innerHTML =
    '<button class="btn back" id="sBack">← Back to dashboard</button>'
    +'<div class="connect settings-panel"><span class="lbl">Background</span><span class="bg-switch settings-bg" role="group" aria-label="Background">'+BG_BUTTONS+'</span>'
    +'<span class="lbl" style="margin-top:20px">PR author / defaults to you</span><input id="sAuth" value="'+esc(author)+'" />'
    +'<span class="lbl" style="margin-top:20px">Closed PR window / hours</span><input id="sHrs" type="number" value="'+esc(String(hours))+'" />'
    +'<div class="row" style="margin-top:24px"><button class="btn primary" id="sSave">Save and reload</button>'
    +'<button class="btn" id="sOut">Sign out</button></div>'
    +(get(LS.refresh,"")?'<div class="help" style="margin-top:16px">Missing PRs from an organization? <a href="https://github.com/settings/connections/applications/'+OAUTH.clientId+'" target="_blank" rel="noopener">Choose which organizations PR Dashboard can see ↗</a></div>':'')
    +'</div>';
  $("sSave").onclick=()=>{ localStorage.setItem(LS.author, $("sAuth").value.trim()); localStorage.setItem(LS.hours, String(Number($("sHrs").value)||HOURS_DEFAULT)); localStorage.removeItem(LS.db); DB=null; load(); };
  $("sOut").onclick=signOut;
  $("sBack").onclick=()=>DB?render():load();
  wireBgSwitch();
}
function signOut(){
  localStorage.removeItem(LS.token); localStorage.removeItem(LS.refresh); localStorage.removeItem(LS.exp); localStorage.removeItem(LS.author); localStorage.removeItem(LS.hours); localStorage.removeItem(LS.me); localStorage.removeItem(LS.db);
  DB=null; ME=null; if(autoTimer){ clearInterval(autoTimer); autoTimer=null; } $("auto").checked=false;
  applyTheme(); showLanding();
}

/* ---------- identity + load ---------- */
function applyIdentity(me){
  ME=me; document.body.classList.add("app");
  $("brandBox").classList.add("hide");
  const av=$("brandAvatar"); av.src=me.avatar_url; av.classList.remove("hide");
  $("brandName").innerHTML="<b>"+esc(me.login)+"</b>"; $("favicon").href=me.avatar_url;
  $("refresh").classList.remove("hide"); $("autoWrap").classList.remove("hide"); $("settings").classList.remove("hide");
  $("srcLink").classList.add("hide"); $("controls").classList.remove("hide");
}
async function connectAndLoad(){
  studyShow("Reading your account");
  try{
    const me=await api("/user");
    localStorage.setItem(LS.me, JSON.stringify({login:me.login, avatar_url:me.avatar_url, name:me.name}));
    applyIdentity(me); await load();
  }catch(e){ localStorage.removeItem(LS.token); studyHide(); showLanding(String(e.message||e)); }
}
async function load(){
  if(!get(LS.token,"")){ showLanding(); return; }
  if(!ME){ const cached=get(LS.me,""); if(cached){ try{ applyIdentity(JSON.parse(cached)); }catch(e){} } }
  const btn=$("refresh"); btn.disabled=true; btn.innerHTML='<span class="spin">↻</span> Refreshing…';
  // Paint the last result instantly; GitHub search takes seconds.
  if(!DB){ try{ DB=JSON.parse(get(LS.db,"")); render(); }catch(e){ $("main").innerHTML=""; studyShow("Rounding up your pull requests"); } }
  try{ DB=await collect(); render(); studyHide(DB.prs.length); try{ localStorage.setItem(LS.db, JSON.stringify(DB)); }catch(e){} }
  catch(e){
    studyHide();
    $("main").innerHTML='<div class="connect settings-panel"><span class="kicker">Couldn’t load</span><p class="err">'+esc(String(e.message||e))+'</p><div class="row" style="margin-top:6px"><button class="btn primary" id="retry">Try again</button><button class="btn" id="fix">Open settings</button></div></div>';
    const r=$("retry"), f=$("fix"); if(r) r.onclick=load; if(f) f.onclick=showSettings;
  }
  finally{ btn.disabled=false; btn.innerHTML="↻ Refresh"; }
}

/* ---------- deploy a copy to the user's own GitHub ---------- */
function b64utf8(s){ return btoa(unescape(encodeURIComponent(s))); }
function debase64(s){ return decodeURIComponent(escape(atob((s||"").replace(/\s/g,"")))); }
async function fetchSource(path){ const r=await api("/repos/"+SRC+"/contents/"+path); return debase64(r.content); }
async function ghRaw(path, opts){
  opts=opts||{}; const token=await freshToken();
  return fetch("https://api.github.com"+path, { method:opts.method||"GET",
    headers:Object.assign({ "Authorization":"Bearer "+token, "Accept":"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" }, opts.body?{"Content-Type":"application/json"}:{}),
    body:opts.body?JSON.stringify(opts.body):undefined, cache:"no-store" })
  .then(async r=>{ let j=null; try{ j=await r.json(); }catch(e){} return {status:r.status, json:j}; });
}
async function putFile(owner,repo,path,content,branch){
  const g=await ghRaw("/repos/"+owner+"/"+repo+"/contents/"+path+"?ref="+branch);
  const body={ message:"Add "+path, content:b64utf8(content), branch };
  if(g.status===200 && g.json && g.json.sha) body.sha=g.json.sha;
  const r=await ghRaw("/repos/"+owner+"/"+repo+"/contents/"+path, {method:"PUT", body});
  if(r.status>=400) throw new Error("Couldn’t upload "+path+" ("+r.status+").");
}
async function waitBuild(owner,repo){
  for(let i=0;i<24;i++){ const b=await ghRaw("/repos/"+owner+"/"+repo+"/pages/builds/latest");
    if(b.json && b.json.status==="built") return true; await new Promise(r=>setTimeout(r,5000)); }
  return false;
}
async function deployFlow(){
  const tv=$("tok").value.trim();
  if(!tv){ $("lerr").textContent="Paste a token first. Deploying needs the repo scope."; return; }
  localStorage.setItem(LS.token, tv); localStorage.removeItem(LS.refresh); localStorage.removeItem(LS.exp);
  const dbtn=$("deploy"), cbtn=$("connect"); dbtn.disabled=true; cbtn.disabled=true; $("lerr").textContent="";
  const set=m=>{ $("dstatus").innerHTML='<span class="spin">↻</span> '+esc(m); };
  try{
    set("Reading your account…");
    const me=await api("/user"); const owner=me.login, repo="pr-dashboard";
    set("Grabbing the latest version…");
    const [idx,app,rd,lic]=await Promise.all([ fetchSource("index.html"), fetchSource("app.js"), fetchSource("README.md").catch(()=>""), fetchSource("LICENSE").catch(()=>"") ]);
    set("Creating "+owner+"/"+repo+" on your account…");
    const cr=await ghRaw("/user/repos", {method:"POST", body:{ name:repo, description:"My PR dashboard: the PRs I'm working on, with live CI", homepage:"https://"+owner+".github.io/"+repo+"/", auto_init:true, has_issues:false, has_wiki:false, has_projects:false }});
    if(cr.status>=400 && cr.status!==422) throw new Error("Couldn’t create the repo ("+cr.status+"). Check that your token has the repo scope.");
    if(cr.status===422) set("You already have that repo, updating it…");
    const info=await api("/repos/"+owner+"/"+repo); const branch=info.default_branch||"main";
    set("Uploading the dashboard…");
    await putFile(owner,repo,"app.js",app,branch);      // before index.html, so the page never loads without its script
    await putFile(owner,repo,"index.html",idx,branch);
    if(rd) await putFile(owner,repo,"README.md",rd,branch);
    if(lic) await putFile(owner,repo,"LICENSE",lic,branch);
    set("Turning on GitHub Pages…");
    await ghRaw("/repos/"+owner+"/"+repo+"/pages", {method:"POST", body:{ source:{ branch, path:"/" } }});
    const url="https://"+owner+".github.io/"+repo+"/";
    set("Waiting for the first build (~1 min)…");
    const built=await waitBuild(owner,repo);
    $("dstatus").innerHTML =
      '<div class="deploy-result">'
      +'<b>'+(built?'It’s live.':'Building… live in ~1 min.')+'</b> Your own copy is at:'
      +'<div style="margin-top:7px"><a href="'+url+'" target="_blank" rel="noopener" class="mono" style="font-size:13.5px;word-break:break-all">'+esc(owner)+'.github.io/pr-dashboard/</a></div>'
      +'<div class="row" style="margin-top:13px"><a class="btn primary" href="'+url+'" target="_blank" rel="noopener">Open it →</a><button class="btn" id="copyUrl">Copy link</button></div>'
      +'<div class="help" style="margin-top:11px">Paste your token there once (new domain) and it’s yours.</div></div>';
    const cp=$("copyUrl"); if(cp) cp.onclick=()=>{ navigator.clipboard.writeText(url).then(()=>{ cp.textContent="Copied ✓"; setTimeout(()=>{ cp.textContent="Copy link"; },1800); }); };
  }catch(e){ $("dstatus").textContent=""; $("lerr").textContent=String(e.message||e); }
  finally{ dbtn.disabled=false; cbtn.disabled=false; }
}

/* ---------- wiring ---------- */
$("srcLink").href=REPO_URL;
document.addEventListener("input", e=>{ if(e.target.id==="q") render(); });
$("chips").addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(!c)return;
  activeFilter=c.dataset.f; document.querySelectorAll(".chip").forEach(x=>x.classList.toggle("active",x===c)); render(); });
$("refresh").addEventListener("click", load);
$("settings").addEventListener("click", showSettings);
$("auto").addEventListener("change", e=>{ if(e.target.checked){ autoTimer=setInterval(load,60000); } else clearInterval(autoTimer); });
document.addEventListener("keydown", e=>{ const q=$("q"); if(e.key==="/"&&document.activeElement!==q&&q&&q.offsetParent){ e.preventDefault(); q.focus(); } });

/* ---------- landing background: wind over the meadow, or flowers behind reeded glass ---------- */
const BGS = { meadow:"assets/meadow.jpg", glass:"assets/glass.jpg", dunes:"assets/dunes.jpg" };
const WIND_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D T; uniform vec2 R, I; uniform float t, M;
float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+1.),f.x), f.y); }
vec2 cover(vec2 s){ return (s-.5*R)/(I*max(R.x/I.x, R.y/I.y))*.985+.5; }   // object-fit: cover, slightly overscanned so swaying never samples past the edge
vec3 field(vec2 uv, float grass, float still){            // grass in the wind; still: 1 where things must not move
  float depth=grass*uv.y*uv.y*(1.-still);                  // foreground sways most
  float g=smoothstep(.3,.85,n(vec2(uv.x*2.4-t*.5, uv.y*3.5+t*.04)));  // gusts rolling left to right
  float sway=sin(t*2.2 - uv.x*10. + uv.y*55. + n(uv*vec2(16,42))*6.);  // neighbouring tufts out of phase
  float dx=depth*(.0025+.009*g)*(.55+.45*sway);
  float sky=(1.-grass)*(1.-still)*.004*sin(t*.08+uv.y*5.);
  vec3 c=texture2D(T, uv-vec2(dx+sky, dx*.3)).rgb;
  float lit=grass*(1.-still);
  return c*(1.-.05*lit*(1.-g)) + vec3(1.,.96,.86)*.08*lit*g*g;  // bent grass catches the light
}
vec3 meadow(vec2 s){ vec2 uv=cover(s); return field(uv, smoothstep(.5,.66,uv.y), 0.); }
float box(vec2 uv, vec4 r){ vec2 d=abs(uv-r.xy)-r.zw; return 1.-smoothstep(0.,.02,max(d.x,d.y)); }
vec3 dunes(vec2 s){
  vec2 uv=cover(s);
  float L=.34+.18*uv.x;                                    // the treeline runs downhill to the right
  float huts=max(max(box(uv,vec4(.2443,.62,.078,.077)), box(uv,vec4(.2989,.5312,.061,.026))),
             max(max(box(uv,vec4(.4029,.575,.078,.058)), box(uv,vec4(.5684,.5938,.08,.051))), box(uv,vec4(.686,.5575,.059,.039))));
  return field(uv, smoothstep(L,L+.08,uv.y), huts);
}
vec3 glass(vec2 s){
  float W=R.y/54., fx=s.x/W, u=fract(fx)*2.-1.;          // rib width matched to the photo; u: -1..1 across a rib
  vec2 b=cover(vec2((floor(fx)+.5)*W - u*W*2.4, s.y));  // each rib is a lens: a wider, mirrored slice of what's behind
  float stem=smoothstep(1.,.3,b.y), gust=n(vec2(b.x*1.6-t*.4, t*.15));  // flowers move, roots stay; gusts travel left to right
  b+=stem*vec2(.012*sin(t*.7+b.y*2.6+b.x*3.)+.03*(gust-.5), .012*sin(t*1.1+b.x*9.)+.008*sin(t*1.9+b.x*23.));
  vec3 c=vec3(0);
  for(int i=-4;i<=4;i++) c+=texture2D(T, b+vec2(float(i)*.0045,0.)).rgb;  // average out the ribs baked into the photo
  c/=9.;
  return c*(1.-.09*smoothstep(-.2,1.,u)) + .06*smoothstep(.6,1.,-u);  // lit left lip, shadowed right flank
}
void main(){
  vec2 s=vec2(gl_FragCoord.x, R.y-gl_FragCoord.y);
  gl_FragColor=vec4(M>1.5 ? dunes(s) : M>.5 ? glass(s) : meadow(s), 1);
}`;
// Compiles a fragment shader over one full-screen triangle; null if the GPU refuses.
function fullscreenProgram(gl, fs){
  const pg=gl.createProgram();
  [[gl.VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0,1);}"],[gl.FRAGMENT_SHADER,fs]].forEach(([type,src])=>{
    const sh=gl.createShader(type); gl.shaderSource(sh,src); gl.compileShader(sh); gl.attachShader(pg,sh); });
  gl.bindAttribLocation(pg,0,"p"); gl.linkProgram(pg);
  if(!gl.getProgramParameter(pg,gl.LINK_STATUS)) return null;
  gl.useProgram(pg);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  return pg;
}

/* ---------- loading: shadow study ---------- */
// Four riso stamps cut from one sheet. The landing's pine (TREE) grows across all of them while we wait, and each
// stamp prints it differently: riso shade, halftone, numbered grid, circle packing, dither. Every beat the styles
// move on a stamp, like flipping through studies. When the PRs arrive the stamps tear apart along their perforations.
// C is where the perforations cross; the caption hangs below-left of it; u is one "unit" (perforation size);
// x runs 0→1 as the stamps part; g is how grown the pine is. TP/TF/BS are the pine in screen px (see studyPine).
const STUDY_FS = `precision highp float;
uniform vec2 R, C, K; uniform float t, u, x, feed, g, beat;   // K: caption size, px
uniform vec3 TP[14]; uniform vec4 TF[11], BS[6]; uniform float TOP;  // trunk (x,y,half width), tufts (c,r), branches (a,b)
float h(vec2 p){ vec3 q=fract(p.xyx*.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }  // sin-free: no moiré
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+1.),f.x), f.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*n(p); p=p*2.03+17.; a*=.5; } return s; }
float seg(vec2 p, vec2 a, vec2 b, out float k){ vec2 pa=p-a, ba=b-a; k=clamp(dot(pa,ba)/dot(ba,ba),0.,1.); return length(pa-ba*k); }
// one edge's perforation: a black band of half-width g whose round teeth bite into the stamp every 2.4u,
// punched outward from the cross as time goes on
float edge(float across, float along, float shown){
  float k=clamp((shown-along)/(2.*u),0.,1.), w=1.1*u*k, r=.85*u*k;
  float yy=mod(along-feed*u, 2.4*u)-1.2*u;                // feed: the teeth crawl outward like sprockets while we wait
  return min(across-w, length(vec2(across-w, yy))-r);
}
// the pine's brightness at q (0 = none): grows from the ground up and sways more toward the top
float pine(vec2 q){
  float H=R.y-TOP, front=R.y-g*H*1.08, hy=clamp((R.y-q.y)/H,0.,1.);
  q.x-=(.6*sin(t*.9)+.4*sin(t*1.7+1.))*.014*H*hy*hy;
  float d=0., k;
  if(q.y>front) for(int i=0;i<13;i++){
    float dd=seg(q,TP[i].xy,TP[i+1].xy,k), w=mix(TP[i].z,TP[i+1].z,k);
    d=max(d, smoothstep(w+1.,w-1.,dd)*(.38+.22*n(vec2(q.x*.12,q.y*.02))));      // bark streaks run up the trunk
  }
  for(int i=0;i<6;i++){
    float grow=clamp((BS[i].w-front)/(H*.1),0.,1.), dd=seg(q,BS[i].xy,BS[i].zw,k);
    if(k<grow) d=max(d, smoothstep(.4*u,.2*u,dd)*.42);
  }
  float nf=fbm(q/(1.4*u));
  for(int i=0;i<11;i++){
    float grow=clamp((TF[i].y+TF[i].w-front)/(H*.12),0.,1.); grow=grow*grow*(3.-2.*grow);
    vec2 r=TF[i].zw*grow+.001, v=q-TF[i].xy;
    if(grow<=0.||abs(v.x)>r.x*1.4||abs(v.y)>r.y*1.8) continue;
    if(v.y>0.) v.y*=1.7;                                    // flat-bottomed, like the dune pines
    float e=min(min(length(v/r), length((v-vec2(-.62,.16)*r)/(r*vec2(.5,.8)))),
                min(length((v-vec2(.62,.12)*r)/(r*vec2(.5,.76))), length((v-vec2(0,-.55)*r)/(r*vec2(.46,.66)))));
    e+=(nf-.5)*.55;                                         // needles fray the edge
    d=max(d, smoothstep(1.,.86,e)*(.45+.35*nf+.3*clamp(-v.y/r.y,0.,1.)));  // lit from above
  }
  return clamp(d,0.,1.);
}
float glyph(float d){ return d<.5?31599.:d<1.5?11415.:d<2.5?29671.:d<3.5?29647.:d<4.5?23497.:d<5.5?31183.:d<6.5?31215.:d<7.5?29330.:d<8.5?31727.:31695.; }
float bayer(vec2 a){ a=floor(a); float b2=fract(dot(a,vec2(.5,a.y*.75))); a=floor(a*.5); return fract(dot(a,vec2(.5,a.y*.75)))*.25+b2; }
void main(){
  vec2 s=vec2(gl_FragCoord.x, R.y-gl_FragCoord.y);
  vec2 q=sign(s-C+.001);                                   // which stamp: (-1,-1) top-left … (1,1) bottom-right
  float id=(q.x+1.)*.5+(q.y+1.);                           // 0 TL, 1 TR, 2 BL, 3 BR
  float e=clamp((x-id*.07)/.79,0.,1.);                     // stamps leave one after another
  vec2 p=s-q*e*e*length(R)*.75;                            // where this pixel sits on its (moving) stamp
  float shown=t*length(R)*.9;                              // perforating runs out from the cross
  vec2 a=(p-C)*q;                                          // distance from the cross, into the stamp
  float d=min(edge(a.x,a.y,shown), edge(a.y,a.x,shown));   // >0 inside the stamp, in px
  vec3 dark=vec3(.12,.29,.16), light=vec3(.83,.87,.29);    // forest on chartreuse
  if(id<.5||id>2.5){ dark=vec3(.29,.31,.85); light=vec3(.90,.77,.89); }  // ultramarine on blush
  vec3 bg=dark, ink=light;
  if(id>2.5){ bg=light; ink=dark; }                        // bottom-right is printed in negative
  float cap=id>1.5&&id<2.5 ? 1.-smoothstep(.55,1.3,length((C-p)/(K*vec2(1.3,3.)+6.*u))) : 0.;  // the caption sits in shade
  float style=mod(id+beat,5.), lit;
  if(style<.5){                                            // riso: dappled shade with the pine's shadow in it
    vec4 crop = id<.5 ? vec4(1.3,.0,.52,.07) : id<1.5 ? vec4(3.2,7.,.53,.035) : id<2.5 ? vec4(2.4,3.,.5,.045) : vec4(1.7,11.,.36,.05);
    vec2 w=p/min(R.x,R.y)*crop.x+crop.y;
    float sway=.06*sin(t*.9+w.y*1.7)+.03*sin(t*1.7+w.x*3.1);
    vec2 wp=w+vec2(sway, sway*.4)+.9*vec2(fbm(w*.8+t*.05), fbm(w*.8+5.2-t*.04));
    float f=fbm(wp)-.5*cap-.45*pine(p+vec2(2.,1.)*u);    // shadow falls a little down-right of the tree
    float grain=h(floor(gl_FragCoord.xy)+floor(t*9.)*13.)-.5;
    lit=smoothstep(crop.z-crop.w, crop.z+crop.w, f+grain*crop.w*1.6);
    bg=dark; ink=light;
  } else if(style<1.5){                                    // halftone dots
    float c=1.15*u; vec2 cc=(floor(p/c)+.5)*c;
    lit=step(length(p-cc), .56*c*sqrt(pine(cc)*(1.-cap)));
  } else if(style<2.5){                                    // numbered grid: each cell prints its brightness 0–9
    float c=2.6*u; vec2 cc=(floor(p/c)+.5)*c, f=fract(p/c)*c;
    float v=pine(cc)*(1.-cap), dg=floor(v*9.99), px=c/7.;
    vec2 gp=floor((f-vec2(2.,1.)*px)/px);
    float on=gp.x>=0.&&gp.x<3.&&gp.y>=0.&&gp.y<5. ? mod(floor(glyph(dg)/exp2((4.-gp.y)*3.+(2.-gp.x))),2.) : 0.;
    float fill=step(1.,min(f.x,f.y))*(.3+.6*floor(v*3.)/3.);   // 1px gutters between cells
    lit=v<.06 ? 0. : mix(fill, fill>.6?0.:1., on);
  } else if(style<3.5){                                    // circle packing: big rings where the pine is solid, small at its edges
    lit=0.;
    for(int i=0;i<3;i++){
      float c=6.*u/exp2(float(i)); vec2 cc=(floor(p/c)+.5)*c; float v=pine(cc)*(1.-cap);
      if(v>.3&&(i==2||h(floor(p/c)+float(i)*7.)<.55+.3*v)){ lit=smoothstep(1.2,.2,abs(length(p-cc)-.42*c)); break; }
    }
  } else {                                                 // ordered dither
    lit=step(bayer(p/2.)+.02, pine(floor(p/2.)*2.+1.)*1.15*(1.-cap));
  }
  vec3 c=mix(bg, ink, lit)*(.95+.08*n(s/70.));             // uneven ink
  c=mix(c, vec3(.1), step(.9997, h(floor(p*.4))));         // paper flecks
  float inside=clamp(d+.5,0.,1.), gap=1.-smoothstep(0.,.25,x);
  gl_FragColor=vec4(c*inside, inside+(1.-inside)*gap);     // premultiplied: black perforations, then see-through as they tear
}`;
// TREE (900×900, ground at the bottom) placed on screen: trunk just left of the vertical perforation so the crown spills over it
function studyPine(w, hh){
  const S=hh/790, ox=w*.63-452*S, oy=hh-892*S, P=([x,y])=>[ox+x*S, oy+y*S];
  const T=TREE.trunk, tw=s=>(16+36*Math.pow(1-s,1.3)+42*Math.exp(-s*20))/2*S;
  const TP=T.flatMap((pt,i)=>[...P(pt), tw(i/(T.length-1))]);
  const TF=[], BS=[];
  TREE.prs.forEach((pr,k)=>{
    const [cx,cy,rx,ry]=pr.tuft, a=T.reduce((m,q)=>Math.abs(q[1]-pr.y)<Math.abs(m[1]-pr.y)?q:m);
    TF.push(...P([cx,cy]), rx*S, ry*S); BS.push(...P(a), ...P([cx,cy]));
    if(k<4) TF.push(...P([a[0]+(cx-a[0])*.5, (a[1]+cy)/2-8]), rx*.42*S, ry*.62*S);  // a smaller clump nearer the trunk
  });
  const [ax,ay,arx,ary]=TREE.apex; TF.push(...P([ax,ay]), arx*S, ary*S);
  return { TP, TF, BS, TOP:oy+(ay-ary)*S };
}
let study=null;
// show the loader (or update its words); safe to call repeatedly
function studyShow(line1, line2){
  if(!study){
    const el=document.createElement("div"); el.id="study"; el.setAttribute("role","status");
    el.innerHTML='<canvas></canvas><p><span></span><span></span></p>';
    document.body.append(el);
    const st=study={el, t0:performance.now(), x:0, raf:0};
    const gl=el.firstChild.getContext("webgl",{antialias:false}), pg=gl&&fullscreenProgram(gl, STUDY_FS);
    if(pg){
      const U=k=>gl.getUniformLocation(pg,k), still=matchMedia("(prefers-reduced-motion: reduce)").matches;
      const frame=now=>{
        const cv=el.firstChild, w=cv.clientWidth, hh=cv.clientHeight, cap=el.querySelector("p");
        if(cv.width!==w||cv.height!==hh){
          cv.width=w; cv.height=hh; gl.viewport(0,0,w,hh);
          const pn=studyPine(w,hh); gl.uniform3fv(U("TP"),pn.TP); gl.uniform4fv(U("TF"),pn.TF); gl.uniform4fv(U("BS"),pn.BS); gl.uniform1f(U("TOP"),pn.TOP);
        }
        const t=still?9:(now-st.t0)/1000, x=st.x, um=Math.min(w,hh)/90;
        gl.uniform2f(U("R"),w,hh); gl.uniform2f(U("C"),w*.7,hh*.49); gl.uniform2f(U("K"),cap.offsetWidth,cap.offsetHeight); gl.uniform1f(U("u"),Math.max(um,5));
        if(!st.out) st.feed=t*1.6; gl.uniform1f(U("feed"),st.feed||0);
        gl.uniform1f(U("g"),still?1:1-Math.exp(-t/2.4)); gl.uniform1f(U("beat"),Math.floor(t/1.1));  // the pine grows; styles move on every beat
        gl.uniform1f(U("t"),t); gl.uniform1f(U("x"),x); gl.drawArrays(gl.TRIANGLES,0,3);
        const e=Math.max(0,(x-.14)/.79), k=e*e*Math.hypot(w,hh)*.75;  // the caption rides the bottom-left stamp
        cap.style.transform="translate("+(-k)+"px,"+k+"px)";
        el.classList.add("gl");
        st.raf=still?0:requestAnimationFrame(frame);
      };
      st.draw=frame; frame(performance.now());
    }
  }
  const sp=study.el.querySelectorAll("p span");
  sp[0].textContent=line1; sp[0].classList.toggle("wait", !study.out); sp[1].textContent=line2||(ME?"@"+ME.login:"");
}
// tear the stamps apart and drop the loader; `found` says how many PRs came back
function studyHide(found){
  const s=study; if(!s||s.out) return; s.out=true;
  if(found!=null) studyShow(found===1?"1 pull request":found+" pull requests", "");
  const still=matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(()=>{
    s.el.classList.add("out");
    const go=performance.now(), tick=now=>{
      s.x=Math.min(1,(now-go)/1600);
      if(still||!s.draw||s.x>=1){ s.el.classList.add("gone"); setTimeout(()=>{ cancelAnimationFrame(s.raf); s.el.remove(); },still?0:500); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, found!=null?650:0);
  study=null;
}

let wind=null;
function initWind(){
  if(matchMedia("(prefers-reduced-motion: reduce)").matches) return; // static CSS image stays
  const cv=$("wind"), gl=cv.getContext("webgl",{antialias:false});
  if(!gl) return;
  const pg=fullscreenProgram(gl, WIND_FS);
  if(!pg) return;
  const U=k=>gl.getUniformLocation(pg,k), uR=U("R"), uT=U("t"), tex={};
  let raf=0, ready=false;
  const frame=ms=>{
    raf=requestAnimationFrame(frame);
    if(!ready) return;
    const d=Math.min(devicePixelRatio,1.5), w=Math.round(cv.clientWidth*d), hh=Math.round(cv.clientHeight*d);
    if(cv.width!==w||cv.height!==hh){ cv.width=w; cv.height=hh; gl.viewport(0,0,w,hh); gl.uniform2f(uR,w,hh); }
    gl.uniform1f(uT, ms/1000); gl.drawArrays(gl.TRIANGLES,0,3);
  };
  // only animate while visible: stops when scrolled past or hidden by body.app
  new IntersectionObserver(([e])=>{ cancelAnimationFrame(raf); raf=e.isIntersecting?requestAnimationFrame(frame):0; }).observe(cv);
  const use=mode=>{ gl.bindTexture(gl.TEXTURE_2D, tex[mode].t); gl.uniform2f(U("I"), tex[mode].w, tex[mode].h); gl.uniform1f(U("M"), Object.keys(BGS).indexOf(mode)); ready=true; };
  wind={ set(mode){
    if(tex[mode]) return use(mode);
    const img=new Image();
    img.onload=()=>{
      const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,img);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      tex[mode]={t, w:img.width, h:img.height};
      use(cv.dataset.bg in tex ? cv.dataset.bg : mode);
    };
    img.src=BGS[mode];
  } };
}
const BG_BUTTONS = ["dunes","meadow","glass"].map(b=>'<button type="button" data-bg="'+b+'">'+b+'</button>').join("");
function wireBgSwitch(){
  document.querySelectorAll(".bg-switch button").forEach(b=>b.onclick=()=>setBg(b.dataset.bg));
  setBg(get(LS.bg,"dunes"));
}
function setBg(mode){
  if(!BGS[mode]) mode="dunes";
  $("wind").dataset.bg=mode; localStorage.setItem(LS.bg, mode);
  if(wind) wind.set(mode);
  document.querySelectorAll(".bg-switch button").forEach(b=>b.setAttribute("aria-pressed", b.dataset.bg===mode));
}

/* ---------- landing tree: an ASCII coastal pine whose branches are pull requests ---------- */
// Tree space is 900×900 with the ground on the bottom edge (the token panel's top rule). The trunk is main;
// each PR is a branch ending in a tuft of needles. Glyphs, git lines and labels all come from this one model.
const TREE = {
  trunk:[[452,892],[449,846],[444,790],[441,732],[444,676],[452,620],[446,562],[434,506],[438,450],[448,396],[440,340],[428,284],[424,232],[430,186]],
  apex:[430,168,98,56],
  prs:[ // y: where it leaves the trunk; tuft: [cx, cy, rx, ry]
    { n:128, ci:"pass",    y:650, tuft:[262,598,116,52] },
    { n:144, ci:"pass",    y:580, tuft:[632,540,112,50] },
    { n:151, ci:"running", y:500, tuft:[276,452,104,48] },
    { n:157, ci:"pass",    y:425, tuft:[612,385,100,46] },
    { n:166, ci:"fail",    y:350, tuft:[300,305,90,42] },
    { n:133, ci:"pass",    y:280, tuft:[578,240,86,40] },
  ],
};
function initTree(cv){
  const ctx=cv.getContext("2d"), css=getComputedStyle(document.documentElement), V=k=>css.getPropertyValue(k).trim();
  const INK=V("--branch-ink"), TXT=V("--text"), LEAF=V("--leaf"), BARK=V("--bark"), SUN=V("--sun"), PAPER=V("--surface"), LINE=V("--line"), MONO=V("--mono");
  const CI={ pass:V("--pass"), fail:V("--fail"), running:V("--run") };
  const still=matchMedia("(prefers-reduced-motion: reduce)").matches;
  const W=900, H=900, COLS=80, CW=W/COLS;
  ctx.font=`100px ${MONO}`;
  const FS=CW/(ctx.measureText("8").width/100), CH=FS*1.08, ROWS=Math.floor(H/CH), OY=H-ROWS*CH;  // rows sit on the ground
  const hash=(a,b)=>{ const x=Math.sin(a*127.1+b*311.7)*43758.5453; return x-Math.floor(x); };
  const noise=(x,y)=>{ const i=Math.floor(x), j=Math.floor(y); let u=x-i, v=y-j; u=u*u*(3-2*u); v=v*v*(3-2*v);
    return (hash(i,j)*(1-u)+hash(i+1,j)*u)*(1-v)+(hash(i,j+1)*(1-u)+hash(i+1,j+1)*u)*v; };
  const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x)), ease=x=>1-Math.pow(1-clamp(x),3);

  // trunk: Catmull-Rom through the control points; slender, flaring a little into the sand
  const T=TREE.trunk, trunk0=[];
  for(let i=0;i<T.length-1;i++){
    const p0=T[Math.max(i-1,0)], p1=T[i], p2=T[i+1], p3=T[Math.min(i+2,T.length-1)];
    for(let k=0;k<8;k++){ const t=k/8, t2=t*t, t3=t2*t;
      trunk0.push([0,1].map(d=>.5*(2*p1[d]+(p2[d]-p0[d])*t+(2*p0[d]-5*p1[d]+4*p2[d]-p3[d])*t2+(3*p1[d]-p0[d]-3*p2[d]+p3[d])*t3))); }
  }
  trunk0.push(T[T.length-1]);
  let trunkLen=0; for(let i=1;i<trunk0.length;i++) trunkLen+=Math.hypot(trunk0[i][0]-trunk0[i-1][0], trunk0[i][1]-trunk0[i-1][1]);
  const trunkW=s=>16+36*Math.pow(1-s,1.3)+42*Math.exp(-s*20);

  // tufts: long, flat-bottomed clumps of needles strung along each branch, like the dune pines
  const tufts=[];
  const mkTuft=(cx,cy,rx,ry,seed)=>{
    const lobes=[[0,0,rx,ry,1],[-.62*rx,.16*ry,.5*rx,.8*ry,.85],[.62*rx,.12*ry,.5*rx,.76*ry,.85],[(hash(seed,1)-.5)*.5*rx,-.55*ry,.46*rx,.66*ry,.75]];
    for(let k=0;k<3;k++) lobes.push([(hash(seed,k+2)-.5)*1.7*rx,(hash(seed,k+5)-.6)*.9*ry,.26*rx,.5*ry,.7]);
    tufts.push({ c:[cx,cy], rx, ry, lobes }); return tufts.length-1;
  };
  const prs=TREE.prs.map((p,k)=>{
    const [cx,cy,rx,ry]=p.tuft, left=cx<450;
    let ti=0; trunk0.forEach((q,i)=>{ if(Math.abs(q[1]-p.y)<Math.abs(trunk0[ti][1]-p.y)) ti=i; });
    const tuft=mkTuft(cx,cy,rx,ry,k+1);
    const a=trunk0[ti], sub=k<4 ? mkTuft(a[0]+(cx-a[0])*.5, (a[1]+cy)/2-8, rx*.42, ry*.62, k+11) : -1;  // a smaller clump nearer the trunk
    return { ...p, left, ti, rx, off:[(left?.18:-.18)*rx, .36*ry], tuft, sub, start:.8+k*.17 };
  });
  const apex=mkTuft(...TREE.apex, 9);

  const near=(pts,x,y)=>{ // closest point on a polyline
    let best=1e9, bi=0, bu=0;
    for(let i=0;i<pts.length-1;i++){
      const a=pts[i], b=pts[i+1], ex=b[0]-a[0], ey=b[1]-a[1];
      const u=clamp(((x-a[0])*ex+(y-a[1])*ey)/(ex*ex+ey*ey||1)), px=a[0]+ex*u-x, py=a[1]+ey*u-y, d=px*px+py*py;
      if(d<best){ best=d; bi=i; bu=u; }
    }
    const a=pts[bi], b=pts[bi+1], ex=b[0]-a[0], ey=b[1]-a[1], l=Math.hypot(ex,ey)||1;
    return { d:Math.sqrt(best), s:(bi+bu)/(pts.length-1), tx:ex/l, ty:ey/l, cx:a[0]+ex*bu, cy:a[1]+ey*bu };
  };
  const bbox=(pts,m)=>{ const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]); return [Math.min(...xs)-m, Math.min(...ys)-m, Math.max(...xs)+m, Math.max(...ys)+m]; };
  const inBox=(b,x,y)=>x>b[0]&&x<b[2]&&y>b[1]&&y<b[3];
  const stroke=(tx,ty)=>{ // the glyph that best draws a line heading this way, in cell space
    const d=((Math.atan2(-ty/CH, tx/CW)*180/Math.PI)+180)%180;
    return d<22.5||d>=157.5 ? "-" : d<67.5 ? "/" : d<112.5 ? "|" : "\\";
  };

  let t0=performance.now(), raf=0, last=0;
  function draw(now){
    const t=still?99:(now-t0)/1000, amp=still?0:clamp((t-2.6)/3);   // grow first, then settle into the breeze
    const R=(a,d)=>ease((t-a)/d);
    const sway=(x,y)=>amp*Math.pow(clamp((892-y)/720),1.6)*(4*Math.sin(t*.9)+2*Math.sin(t*1.7+1.1)+Math.sin(t*2.9+.4));
    const mv=p=>{ const dx=sway(p[0],p[1]); return [p[0]+dx, p[1]-Math.abs(dx)*.06]; };
    const trunk=trunk0.map(mv), tb=bbox(trunk,50), tr=R(.1,1.3), base=trunk[0];
    const tC=tufts.map((td,i)=>{ const c=mv(td.c); return [c[0]+amp*1.1*Math.sin(t*2.1+i*1.7), c[1]+amp*.7*Math.sin(t*1.6+i)]; });
    const bloomOf=tufts.map((_,i)=>i===apex ? R(1.05,1) : 0);
    const br=prs.map(p=>{
      const a=trunk[p.ti], c=tC[p.tuft], nd=[c[0]+p.off[0], c[1]+p.off[1]], m=[a[0]+(nd[0]-a[0])*.45, a[1]+(nd[1]-a[1])*.1+12], pts=[];
      for(let i=0;i<=20;i++){ const u=i/20; pts.push([0,1].map(d=>(1-u)*(1-u)*a[d]+2*(1-u)*u*m[d]+u*u*nd[d])); }
      bloomOf[p.tuft]=R(p.start+.45,.9); if(p.sub>=0) bloomOf[p.sub]=R(p.start+.3,.9);
      return { p, pts, nd, rv:R(p.start,.7), box:bbox(pts,24), lab:R(p.start+1,.5) };
    });
    // labels are tags that never shrink below ~11.5px on screen, however small the tree gets
    const LF=Math.max(19, 11.5*W/(cv.clientWidth||W)), PAD=LF*.45;
    ctx.font=`600 ${LF}px ${MONO}`;
    const labels=br.map(b=>{ const s="#"+b.p.n, w=ctx.measureText(s).width, x=b.p.left ? b.nd[0]-b.p.rx*1.18-14-w : b.nd[0]+b.p.rx*1.18+14;
      return { s, x:clamp(x, PAD+2, W-w-PAD-2), y:b.nd[1], w, a:b.lab }; });
    const mainW=ctx.measureText("main").width;
    labels.push({ s:"main", x:base[0]-36-mainW, y:H-LF*.95, w:mainW, a:R(0,.5) });

    const dens=(x,y)=>{
      let f=0, best=0, bi=-1;
      for(let i=0;i<tufts.length;i++){
        const c=tC[i]; if(Math.abs(x-c[0])>tufts[i].rx*1.4||Math.abs(y-c[1])>tufts[i].ry*1.5) continue;
        let fi=0;
        for(const [dx,dy,rx,ry,w] of tufts[i].lobes){ const X=(x-c[0]-dx)/rx, yr=y-c[1]-dy, Y=yr/(yr>0?ry*.55:ry), q=X*X+Y*Y; if(q<1) fi+=w*Math.pow(1-q,1.4); }
        if(fi>best){ best=fi; bi=i; } f+=fi;
      }
      return bi<0 ? [0,-1] : [f*(.6+.8*noise((x-tC[bi][0])*.04+bi*7, (y-tC[bi][1])*.07)), bi];
    };

    const buckets=new Map(), put=(ch,x,y,al,col=TXT)=>{ const k=col+"|"+Math.round(clamp(al)*24); if(!buckets.has(k)) buckets.set(k,[]); buckets.get(k).push(ch,x,y); };
    for(let j=0;j<ROWS;j++) for(let i=0;i<COLS;i++){
      const x=(i+.5)*CW, y=OY+(j+.5)*CH, r=hash(i,j);
      // keep clear around nodes, labels and the git lines so they read cleanly
      if(Math.hypot(x-base[0], y-base[1])<16||tr>.99&&Math.hypot(x-trunk[trunk.length-1][0], (y-trunk[trunk.length-1][1])*.8)<13) continue;
      if(br.some(b=>b.rv>.98&&Math.hypot(x-b.nd[0],(y-b.nd[1])*.8)<15)) continue;
      if(labels.some(l=>l.a>0&&x>l.x-PAD-4&&x<l.x+l.w+PAD+4&&Math.abs(y-l.y)<LF*.8+CH*.4)) continue;
      const nt=inBox(tb,x,y)?near(trunk,x,y):null;
      if(nt&&nt.s<=tr&&nt.d<CW*.42&&nt.s<.97) continue;
      if(br.some(b=>b.rv>0&&inBox(b.box,x,y)&&(n=>n.s<=b.rv&&n.d<CW*.55)(near(b.pts,x,y)))) continue;
      // needles: little peaks on top, drooping tips below, dense M/W inside; sunset catches the right edges
      const [f,pi]=dens(x,y);
      if(f>.12&&pi>=0){
        const bloom=bloomOf[pi], r2=hash(i+31,j+17);
        if(r2<bloom*1.2){
          const g=(dx,dy)=>dens(x+dx,y+dy)[0], gx=g(CW*.5,0)-g(-CW*.5,0), gy=g(0,CH*.5)-g(0,-CH*.5), gl=Math.hypot(gx,gy)||1, L=gx/gl, D=gy/gl;
          let ch="";
          if(r2>=bloom) ch=f>.2?"'":"";                                          // budding
          else if(f>.56) ch=r<.46?"M":r<.92?"W":"N";
          else if(f>.34) ch=D>.45 ? (L>.35?"/":L<-.35?"\\":r<.5?"w":"m") : D<-.45 ? (L>.35?"`":L<-.35?"'":r<.5?"V":"v") : (L>0?"M":"W");
          else if(f>.2) ch=D>.4 ? (r<.6?"^":",") : D<-.4 ? (r<.5?"'":"`") : (L>0?"<":">");
          else if(r>.8) ch=r>.93?",":"'";                                        // stray needles
          if(ch){
            const pc=tC[pi], td=tufts[pi], rel=clamp(((y-pc[1])/td.ry)*.5+.5)*.65+clamp(((pc[0]-x)/td.rx)*.5+.5)*.35;  // sun from the right
            const lit=f<=.56&&D>.15&&x>pc[0]+td.rx*.15;
            put(ch,x,y,(.42+.32*rel+(f>.56?.05:0))*(f>.2?1:.8)+(lit?.1:0), lit?SUN:LEAF); continue;
          }
        }
        if(f>.3) continue;
      }
      if(nt&&nt.s<=tr){
        const hw=trunkW(nt.s)/2;
        if(nt.d<hw){
          if(nt.d>hw-CW*1.1){ // bark edge, bending with the root flare
            const k=(trunkW(Math.min(nt.s+.01,1))-trunkW(nt.s))/(.02*trunkLen), ox=(x-nt.cx)/nt.d, oy=(y-nt.cy)/nt.d;
            put(r<.1&&nt.s>.15 ? (ox<0?"(":")") : stroke(nt.tx+ox*k, nt.ty+oy*k), x, y, ox<0?.78:.86, ox<0?BARK:SUN);
          } else put(r<.55 ? stroke(nt.tx,nt.ty) : r<.75 ? ":" : r<.9 ? "'" : "(", x, y, .52+.16*r, BARK);
          continue;
        }
      }
      if(j>=ROWS-2&&Math.abs(x-base[0])<190-r*80&&r<.62) put(j===ROWS-1 ? ",'\\|/\"wv"[Math.floor(r*80)%8] : r<.3?",":"'", x, y, (.34+.2*r)*R(0,.6), LEAF); // dune grass at its feet
    }

    const dpr=Math.min(devicePixelRatio,2), cw=Math.round(cv.clientWidth*dpr), chh=Math.round(cv.clientHeight*dpr);
    if(cv.width!==cw||cv.height!==chh){ cv.width=cw; cv.height=chh; }
    ctx.setTransform(cv.width/W,0,0,cv.height/H,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.font=`${FS}px ${MONO}`; ctx.textAlign="center"; ctx.textBaseline="middle";
    for(const [k,list] of buckets){ const [col,a]=k.split("|"); ctx.fillStyle=col; ctx.globalAlpha=a/24; for(let n=0;n<list.length;n+=3) ctx.fillText(list[n],list[n+1],list[n+2]); }

    // git graph: main up the trunk, one line per PR, a node coloured by its CI
    const px=W/cv.clientWidth;
    ctx.globalAlpha=.92; ctx.strokeStyle=INK; ctx.lineCap="round"; ctx.lineJoin="round";
    const line=(pts,frac,lw)=>{ const n=Math.round((pts.length-1)*frac); if(n<1) return; ctx.lineWidth=lw*px; ctx.beginPath(); ctx.moveTo(...pts[0]); for(let i=1;i<=n;i++) ctx.lineTo(...pts[i]); ctx.stroke(); };
    line(trunk, tr, 2.2);
    br.forEach(b=>line(b.pts, b.rv, 1.9));
    const node=(p,fill,a,rad=4.4)=>{ if(a<=0) return; ctx.globalAlpha=a; ctx.beginPath(); ctx.arc(p[0],p[1],rad*px*(.6+.4*a),0,7); ctx.fillStyle=fill; ctx.fill(); ctx.lineWidth=1.5*px; ctx.stroke(); };
    node(base, INK, R(0,.4), 3.6);
    if(tr>.99) node(trunk[trunk.length-1], INK, R(1.3,.4), 3);
    br.forEach(b=>{
      const a=ease((b.rv-.9)*10);
      if(b.p.ci==="running"&&a>0&&!still){ const ph=(t*.7)%1; ctx.globalAlpha=a*(1-ph)*.6; ctx.beginPath(); ctx.arc(b.nd[0],b.nd[1],(4.4+ph*9)*px,0,7); ctx.lineWidth=1.2*px; ctx.strokeStyle=CI.running; ctx.stroke(); ctx.strokeStyle=INK; }
      node(b.nd, CI[b.p.ci], a);
    });
    ctx.font=`600 ${LF}px ${MONO}`; ctx.textAlign="left";
    labels.forEach(l=>{ if(l.a<=0) return;
      ctx.globalAlpha=l.a*.9; ctx.beginPath(); ctx.roundRect(l.x-PAD, l.y-LF*.78, l.w+PAD*2, LF*1.56, LF*.3);
      ctx.fillStyle=PAPER; ctx.fill(); ctx.lineWidth=px; ctx.strokeStyle=LINE; ctx.stroke();
      ctx.globalAlpha=l.a; ctx.fillStyle=INK; ctx.fillText(l.s, l.x, l.y+LF*.04); });
    ctx.globalAlpha=1;
  }
  if(still){ draw(0); return; }
  const loop=now=>{ if(!cv.isConnected) return; raf=requestAnimationFrame(loop); if(now-last<(now-t0<4000?33:50)) return; last=now; draw(now); }; // 30fps growing, 20fps swaying
  new IntersectionObserver(([e])=>{ cancelAnimationFrame(raf); raf=e.isIntersecting&&cv.isConnected?requestAnimationFrame(loop):0; }).observe(cv);
}

applyTheme(); initWind(); setBg(get(LS.bg,"dunes"));
oauthFinish().then(handled=>{ if(handled) return; if(get(LS.token,"")) connectAndLoad(); else showLanding(); });
