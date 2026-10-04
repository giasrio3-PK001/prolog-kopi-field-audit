const cfg = window.APP_CONFIG || {};
const seed = window.SEED_DATA || {sops:[], indicators:[], outlets:[], crews:[], audits:[], actions:[]};

let db = null;
let onlineMode = false;
let realtimeChannel = null;
let pendingEvidence = null;

const state = {
  sops: seed.sops || [],
  indicators: seed.indicators || [],
  outlets: seed.outlets || [],
  crews: seed.crews || [],
  audits: [],
  actions: [],
  sopProgress: [],
  lastSync: null,
  selectedSop: seed.sops?.[0]?.code || null
};

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm = v => String(v ?? '').trim().toLowerCase();
const today = () => new Date().toISOString().slice(0,10);
const nowTime = () => new Date().toTimeString().slice(0,5);
const dateKey = v => { const d = new Date(v); return isNaN(d) ? null : d.getTime(); };
const clamp = (n,min,max) => Math.min(max, Math.max(min,n));

function showToast(msg){
  const t = $('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>t.classList.remove('show'), 2600);
}

function statusFor(score){return score===5?'EXCELLENT':score===4?'GOOD':score===3?'COACHING':'BAD';}
function riskFor(score){return score<=2?'HIGH':score===3?'MEDIUM':'LOW';}
function coachingFor(score){return score<=3;}
function recommendationFor(score){
  return score===5?'Pertahankan standar & jadikan contoh':
    score===4?'Brief coaching bila perlu':
    score===3?'Coaching ulang + observasi berikutnya':'Perbaikan segera + follow-up';
}
function earlyWarningFor(score, recurring){return score<=2&&recurring?'CRITICAL':score<=2?'WARNING':score===3?'MONITOR':'NORMAL';}
function scoreBadge(score){
  const s = Number(score||0);
  return `<span class="badge ${s>=4?'ok':s===3?'warn':'bad'}">${esc(s.toFixed(1))}</span>`;
}
function statusBadge(status){
  const map = {LENGKAP:'ok',SELESAI:'ok',GOOD:'ok',EXCELLENT:'ok',PROSES:'warn','BELUM LENGKAP':'warn','BELUM MULAI':'bad','NOT STARTED':'bad',HIGH:'bad',MEDIUM:'warn',LOW:'ok',OPEN:'warn','ON PROGRESS':'warn',DONE:'ok'};
  return `<span class="badge ${map[status]||'neutral'}">${esc(status)}</span>`;
}

function persistLocal(){
  localStorage.setItem('pk_audits', JSON.stringify(state.audits));
  localStorage.setItem('pk_actions', JSON.stringify(state.actions));
}

function seedLocal(){
  const la = JSON.parse(localStorage.getItem('pk_audits') || 'null');
  const lc = JSON.parse(localStorage.getItem('pk_actions') || 'null');
  state.audits = Array.isArray(la) ? la : (seed.audits||[]).map((x,i)=>({...x,id:'seed-a-'+i,created_at:new Date(`${x.audit_date}T${x.audit_time||'08:00:00'}`).toISOString()}));
  state.actions = Array.isArray(lc) ? lc : (seed.actions||[]).map((x,i)=>({...x,id:'seed-c-'+i,created_at:new Date(`${x.action_date||today()}T08:00:00`).toISOString()}));
  persistLocal();
  rebuildSopProgress();
}

function rebuildSopProgress(){
  const map = new Map();
  for(const s of state.sops){
    const target = Number(s.indicator_count||0);
    const actual = state.indicators.filter(i=>i.sop_code===s.code).length;
    const pct = target ? +(actual/target*100).toFixed(2) : 0;
    map.set(s.code, {
      sop_code:s.code, sop_title:s.title, target, aktual:actual,
      selisih:Math.max(target-actual,0), completion_percentage:pct,
      status:actual===0?'BELUM MULAI':actual>=target?'LENGKAP':'PROSES'
    });
  }
  state.sopProgress = Array.from(map.values()).sort((a,b)=>a.sop_code.localeCompare(b.sop_code));
}

async function initDB(){
async function initDB(){
  if(cfg.FORCE_LOCAL || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return false;

  try{
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');

    db = mod.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_ANON_KEY,
      {
        auth:{
          persistSession:true,
          autoRefreshToken:true
        }
      }
    );

    const {data:{session}} = await db.auth.getSession();

    if(!session?.user){
      onlineMode = false;
      showLoginScreen();
      return false;
    }

    const [sops, indicators, outlets, crews, audits, actions, progress] = await Promise.all([
      db.from('sops').select('*').order('code'),
      db.from('indicators').select('*').order('sop_code').order('id'),
      db.from('outlets').select('*').order('name'),
      db.from('crews').select('*').order('crew_id'),
      db.from('audits').select('*').order('created_at',{ascending:false}).limit(1000),
      db.from('coaching_actions').select('*').order('created_at',{ascending:false}).limit(500),
      db.from('sop_progress').select('*').order('sop_code')
    ]);

    for(const r of [sops, indicators, outlets, crews, audits, actions, progress]){
      if(r.error) throw r.error;
    }

    state.sops = sops.data || [];
    state.indicators = indicators.data || [];
    state.outlets = outlets.data || [];
    state.crews = crews.data || [];
    state.audits = audits.data || [];
    state.actions = actions.data || [];
    state.sopProgress = progress.data || [];

    if(!state.sopProgress.length) rebuildSopProgress();

    state.lastSync = new Date();
    onlineMode = true;

    hideLoginScreen();
    subscribeRealtime();

    return true;
  }catch(err){
    console.warn('Supabase init gagal.', err);
    onlineMode = false;
    setConnection('• Koneksi Supabase gagal','connection');
    return false;
  }
}
function showLoginScreen(message=''){
  let gate = $('authGate');

  if(!gate){
    gate = document.createElement('div');
    gate.id = 'authGate';

    gate.innerHTML = `
      <div style="
        position:fixed;
        inset:0;
        z-index:99999;
        background:#f5f7fa;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:24px;
      ">
        <div style="
          width:100%;
          max-width:420px;
          background:#fff;
          border-radius:18px;
          padding:28px;
          box-shadow:0 20px 60px rgba(0,0,0,.12);
        ">
          <div style="font-size:24px;font-weight:800;margin-bottom:6px">
            PROLOG KOPI
          </div>

          <div style="font-size:14px;color:#667085;margin-bottom:24px">
            Field Audit · Login
          </div>

          <form id="authForm">
            <label style="display:block;font-size:13px;font-weight:700;margin-bottom:6px">
              Email
            </label>

            <input
              id="authEmail"
              type="email"
              autocomplete="username"
              required
              placeholder="email"
              style="
                width:100%;
                box-sizing:border-box;
                padding:12px 14px;
                border:1px solid #d0d5dd;
                border-radius:10px;
                margin-bottom:14px;
                font-size:14px;
              "
            >

            <label style="display:block;font-size:13px;font-weight:700;margin-bottom:6px">
              Password
            </label>

            <input
              id="authPassword"
              type="password"
              autocomplete="current-password"
              required
              placeholder="password"
              style="
                width:100%;
                box-sizing:border-box;
                padding:12px 14px;
                border:1px solid #d0d5dd;
                border-radius:10px;
                margin-bottom:14px;
                font-size:14px;
              "
            >

            <div
              id="authError"
              style="
                display:none;
                color:#b42318;
                background:#fef3f2;
                padding:10px 12px;
                border-radius:9px;
                font-size:13px;
                margin-bottom:14px;
              "
            ></div>

            <button
              id="authSubmit"
              type="submit"
              style="
                width:100%;
                border:0;
                border-radius:10px;
                padding:13px;
                font-size:14px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Login
            </button>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(gate);

    $('authForm').addEventListener('submit', async e=>{
      e.preventDefault();

      const email = $('authEmail').value.trim();
      const password = $('authPassword').value;
      const errorBox = $('authError');
      const btn = $('authSubmit');

      errorBox.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Login...';

      try{
        if(!db){
          const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');

          db = mod.createClient(
            cfg.SUPABASE_URL,
            cfg.SUPABASE_ANON_KEY,
            {
              auth:{
                persistSession:true,
                autoRefreshToken:true
              }
            }
          );
        }

        const {error} = await db.auth.signInWithPassword({
          email,
          password
        });

        if(error) throw error;

        const ok = await initDB();

        if(!ok){
          throw new Error('Login berhasil, tetapi data Supabase belum bisa dimuat.');
        }

        renderAll();
        setConnection('• Realtime aktif','connection');

      }catch(err){
        console.warn('Login gagal:', err);

        errorBox.textContent = err?.message || 'Login gagal.';
        errorBox.style.display = 'block';

      }finally{
        btn.disabled = false;
        btn.textContent = 'Login';
      }
    });
  }

  gate.style.display = 'block';

  setConnection('• Login diperlukan','connection');
}

function hideLoginScreen(){
  const gate = $('authGate');
  if(gate) gate.style.display = 'none';
}

function subscribeRealtime(){
  if(!db || realtimeChannel) return;
  realtimeChannel = db.channel('pk-live')
    .on('postgres_changes',{event:'*',schema:'public',table:'audits'},payload=>handleLive('audit',payload))
    .on('postgres_changes',{event:'*',schema:'public',table:'coaching_actions'},payload=>handleLive('action',payload))
    .subscribe(status=>{
      if(status==='SUBSCRIBED') setConnection('● Realtime aktif','connection realtime');
    });
}

function handleLive(type,payload){
  const arr = type==='audit' ? state.audits : state.actions;
  const id = (payload.new || payload.old || {}).id;
  const i = arr.findIndex(x=>x.id===id);
  if(payload.eventType==='DELETE'){ if(i>=0) arr.splice(i,1); }
  else if(i>=0) arr[i] = {...arr[i],...payload.new};
  else arr.unshift(payload.new);
  state.lastSync = new Date();
  persistLocal();
  renderAll();
}

function setConnection(text, cls='connection'){
  const el = $('connectionBadge');
  if(!el) return;
  el.textContent = text;
  el.className = cls;
}

async function saveAudit(record){
  if(onlineMode && db){
    const {data,error} = await db.from('audits').insert(record).select().single();
    if(error) throw error;
    state.audits.unshift(data);
  }else{
    state.audits.unshift({...record,id:crypto.randomUUID(),created_at:new Date().toISOString(),_pending:true});
    persistLocal();
  }
}

async function saveAction(record){
  if(onlineMode && db){
    const {data,error} = await db.from('coaching_actions').insert(record).select().single();
    if(error) throw error;
    state.actions.unshift(data);
  }else{
    state.actions.unshift({...record,id:crypto.randomUUID(),created_at:new Date().toISOString(),_pending:true});
    persistLocal();
  }
}

async function syncPending(){
  if(!onlineMode || !db) return;
  for(const item of state.audits.filter(x=>x._pending)){
    const copy = {...item}; delete copy._pending; delete copy.id; delete copy.created_at;
    const {data,error} = await db.from('audits').insert(copy).select().single();
    if(!error){ Object.assign(item,data); delete item._pending; }
  }
  for(const item of state.actions.filter(x=>x._pending)){
    const copy = {...item}; delete copy._pending; delete copy.id; delete copy.created_at;
    const {data,error} = await db.from('coaching_actions').insert(copy).select().single();
    if(!error){ Object.assign(item,data); delete item._pending; }
  }
  persistLocal();
}

function setSelectOptions(select,items,valueFn,labelFn,placeholder){
  if(!select) return;
  select.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') + items.map(x=>`<option value="${esc(valueFn(x))}">${esc(labelFn(x))}</option>`).join('');
}

function initLookups(){
  setSelectOptions($('outlet'), state.outlets.filter(o=>o.status==='ACTIVE' || !o.status), o=>o.name, o=>o.name, 'Pilih outlet');
  setSelectOptions($('dashboardOutlet'), [{name:'ALL'}, ...state.outlets], o=>o.name, o=>o.name, null);
  setSelectOptions($('actionOutlet'), state.outlets.filter(o=>o.status==='ACTIVE' || !o.status), o=>o.name, o=>o.name, 'Pilih outlet');
  setSelectOptions($('sop'), state.sops, s=>s.code, s=>`${s.code} — ${s.title}`, 'Pilih SOP');
  setSelectOptions($('actionSop'), state.sops, s=>s.code, s=>`${s.code} — ${s.title}`, 'Pilih SOP');
  updateCrewSelect('');
  updateActionCrewSelect('');
  updateIndicators('');
}

function updateCrewSelect(outlet){
  const arr = state.crews.filter(c=>!outlet || c.outlet===outlet);
  setSelectOptions($('crew'),arr,c=>c.name,c=>`${c.name}${c.position?' — '+c.position:''}`,'Pilih crew');
  $('position').value='';
}
function updateActionCrewSelect(outlet){
  const arr = state.crews.filter(c=>!outlet || c.outlet===outlet);
  setSelectOptions($('actionCrew'),arr,c=>c.name,c=>c.name,'Pilih crew');
}
function updateIndicators(code){
  const arr = state.indicators.filter(i=>i.sop_code===code);
  setSelectOptions($('indicator'),arr,i=>i.indicator,i=>`${i.priority==='HIGH'?'[HIGH] ':''}${i.indicator}`,'Pilih indikator');
}

function initFormDefaults(){
  $('auditDate').value=today();
  $('auditTime').value=nowTime();
  $('actionDate').value=today();
  $('dueDate').value=today();
  $('actionDue').value=today();
  $('scorePicker').innerHTML=[5,4,3,2,1].map(s=>`<button type="button" class="score-btn" data-score="${s}">${s}</button>`).join('');
  document.querySelectorAll('.score-btn').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.score-btn').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    renderScoreSummary(Number(b.dataset.score));
  }));
  document.querySelector('.score-btn[data-score="3"]')?.classList.add('active');
  renderScoreSummary(3);
}
function renderScoreSummary(score){
  const st=statusFor(score), risk=riskFor(score);
  $('scoreSummary').innerHTML=`
    <div class="summary-row"><span>Status</span>${statusBadge(st)}</div>
    <div class="summary-row"><span>Risiko</span>${statusBadge(risk)}</div>
    <div class="summary-row"><span>Butuh Coaching</span><strong>${coachingFor(score)?'YA':'TIDAK'}</strong></div>
    <div class="summary-row"><span>Rekomendasi</span><strong>${esc(recommendationFor(score))}</strong></div>`;
}

function readScore(){return Number(document.querySelector('.score-btn.active')?.dataset.score||3);}
function currentRecurring(outlet,crew,sop){
  return state.audits.filter(a=>norm(a.outlet)===norm(outlet)&&norm(a.crew)===norm(crew)&&a.sop_code===sop&&Number(a.score)<=3).length>=1;
}
function recordAuditFromForm(){
  const score=readScore();
  const outlet=$('outlet').value, crew=$('crew').value, sop=$('sop').value, indicator=$('indicator').value;
  const recurring=currentRecurring(outlet,crew,sop);
  return {
    audit_date:$('auditDate').value,
    audit_time:$('auditTime').value,
    outlet,crew,position:$('position').value,shift:$('shift').value,sop_code:sop,indicator,score,
    status:statusFor(score),diagnosis:score>=4?'Standar terpenuhi':score===3?'Belum konsisten — perlu coaching':'Tidak memenuhi standar — perlu perbaikan segera',
    risk_level:riskFor(score),needs_coaching:coachingFor(score),recommendation:recommendationFor(score),
    finding:$('finding').value,action:$('action').value,pic_action:$('picAction').value,due_date:$('dueDate').value,
    follow_up:$('followUp').value,auditor:$('auditor').value,root_cause:$('rootCause').value,
    root_cause_detail:$('rootCauseDetail').value,diagnosis_type:$('diagnosisType').value,recurring_issue:recurring,
    early_warning:earlyWarningFor(score,recurring),priority:score<=2?'HIGH':score===3?'MEDIUM':'LOW',
    scope:$('diagnosisType').value==='Outlet Pattern'?'Outlet-wide':$('diagnosisType').value==='Area-wide'?'Area-wide':'Individual',
    review_status:score<=3?'OPEN':'MONITOR',evidence_url:null
  };
}

$('auditForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const rec=recordAuditFromForm();
    if(!rec.outlet||!rec.crew||!rec.sop_code||!rec.indicator){showToast('Lengkapi outlet, crew, SOP, dan indikator.');return;}
    if(pendingEvidence) rec.evidence_url=onlineMode?await uploadEvidence(pendingEvidence):pendingEvidence;
    await saveAudit(rec); await syncPending();
    showToast('Audit tersimpan');
    e.target.reset(); initFormDefaults(); initLookups(); pendingEvidence=null; $('evidencePreview').innerHTML='';
    renderAll();
  }catch(err){console.error(err);showToast('Gagal menyimpan audit: '+(err.message||'error'));}
});

$('coachingForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const rec={action_date:$('actionDate').value,outlet:$('actionOutlet').value,crew:$('actionCrew').value,sop_code:$('actionSop').value,
      finding:$('actionFinding').value,category:$('actionCategory').value,priority:$('actionPriority').value,action:$('actionText').value,
      pic:$('actionPic').value,due_date:$('actionDue').value,status:$('actionStatus').value,evidence_url:$('actionEvidence').value||null,
      supervisor_review:$('actionReview').value};
    await saveAction(rec); await syncPending(); showToast('Coaching action tersimpan');
    e.target.reset(); $('actionDate').value=today(); $('actionDue').value=today(); updateActionCrewSelect(''); renderAll();
  }catch(err){console.error(err);showToast('Gagal menyimpan coaching: '+(err.message||'error'));}
});

async function uploadEvidence(dataUrl){
  const blob=await (await fetch(dataUrl)).blob();
  const fileName=`evidence/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  const {error}=await db.storage.from('audit-evidence').upload(fileName,blob,{contentType:'image/jpeg',upsert:false});
  if(error) throw error;
  return db.storage.from('audit-evidence').getPublicUrl(fileName).data.publicUrl;
}
function compressImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onload=()=>{const img=new Image(); img.onload=()=>{
      const max=1280,scale=Math.min(1,max/Math.max(img.width,img.height));
      const c=document.createElement('canvas'); c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height); resolve(c.toDataURL('image/jpeg',.75));
    }; img.onerror=reject; img.src=reader.result;}; reader.onerror=reject; reader.readAsDataURL(file);
  });
}
$('outlet').addEventListener('change',e=>updateCrewSelect(e.target.value));
$('crew').addEventListener('change',e=>{const c=state.crews.find(x=>norm(x.name)===norm(e.target.value)&&x.outlet===$('outlet').value);$('position').value=c?.position||'';});
$('sop').addEventListener('change',e=>updateIndicators(e.target.value));
$('actionOutlet').addEventListener('change',e=>updateActionCrewSelect(e.target.value));
$('evidence').addEventListener('change',async e=>{const f=e.target.files?.[0];if(!f)return;pendingEvidence=await compressImage(f);$('evidencePreview').innerHTML=`<img src="${pendingEvidence}" alt="Preview bukti">`;});

function getRangeDays(){return Number($('rangeFilter')?.value||30);}
function filterAudits(){
  const days=getRangeDays(), outlet=$('dashboardOutlet')?.value||'ALL', cutoff=Date.now()-days*86400000;
  return state.audits.filter(a=>{const t=dateKey(a.audit_date); return t!==null && t>=cutoff && (outlet==='ALL'||norm(a.outlet)===norm(outlet));});
}
function recentActions(){
  const outlet=$('dashboardOutlet')?.value||'ALL';
  return state.actions.filter(a=>outlet==='ALL'||norm(a.outlet)===norm(outlet));
}
function avg(arr){return arr.length?arr.reduce((s,a)=>s+Number(a.score||0),0)/arr.length:0;}
function actionSla(a){
  if(a.status==='DONE')return 'CLOSED';
  if(!a.due_date)return 'OPEN';
  const diff=(dateKey(a.due_date)-Date.now())/86400000;
  return diff<0?'OVERDUE':diff<=2?'DUE SOON':'ON TRACK';
}
function masterSummary(){
  const target=state.sops.reduce((s,x)=>s+Number(x.indicator_count||0),0);
  const actual=state.indicators.length;
  const complete=state.sopProgress.filter(x=>Number(x.aktual||0)>=Number(x.target||0)).length;
  const notStarted=state.sopProgress.filter(x=>Number(x.aktual||0)===0).length;
  return {target,actual,percent:target?actual/target*100:0,complete,notStarted};
}

function renderDashboard(){
  const audits=filterAudits(), actions=recentActions(), m=masterSummary();
  const bad=audits.filter(a=>Number(a.score)<=2).length;
  const high=audits.filter(a=>a.risk_level==='HIGH'||Number(a.score)<=2).length;
  const overdue=actions.filter(a=>actionSla(a)==='OVERDUE').length;
  const open=actions.filter(a=>a.status!=='DONE').length;
  const outletsCovered=new Set(audits.map(a=>norm(a.outlet)).filter(Boolean)).size;

  const kpis=[
    ['Audit '+getRangeDays()+'H',audits.length,'volume'],
    ['Avg Score',audits.length?avg(audits).toFixed(2):'—','score'],
    ['High Risk',high,'risk'],
    ['Open Action',open,'action'],
    ['Outlet Audited',outletsCovered,'coverage'],
    ['Master SOP',`${m.actual}/${m.target}`,'master']
  ];
  $('kpis').innerHTML=kpis.map(([label,val,tag])=>`<div class="kpi"><div class="kpi-tag">${esc(tag)}</div><div class="v">${esc(val)}</div><div class="l">${esc(label)}</div></div>`).join('');

  const overall=clamp(audits.length?avg(audits)/5*100:0,0,100);
  $('dashboardProgress').innerHTML=`<div class="progress-value">${audits.length?overall.toFixed(0):'0'}%</div><div class="progress-sub">${audits.length?'Performance audit '+getRangeDays()+' hari':'Belum ada audit pada periode ini'}</div><div class="bar big"><span style="width:${overall}%"></span></div><div class="progress-meta"><span>Avg score <strong>${audits.length?avg(audits).toFixed(2):'—'}</strong></span><span>${bad} audit score ≤2</span></div>`;

  const mp=clamp(m.percent,0,100);
  $('masterProgress').innerHTML=`<div class="progress-value">${m.percent.toFixed(1)}%</div><div class="progress-sub">${m.actual} indikator tersimpan dari ${m.target} target master</div><div class="bar big"><span style="width:${mp}%"></span></div><div class="progress-meta"><span>${m.complete} SOP lengkap</span><span>${m.notStarted} SOP belum mulai</span></div>`;

  const outlets=state.outlets.map(o=>{
    const rows=audits.filter(a=>norm(a.outlet)===norm(o.name));
    return {name:o.name,rows,avg:avg(rows),bad:rows.filter(a=>Number(a.score)<=2).length,high:rows.filter(a=>a.risk_level==='HIGH'||Number(a.score)<=2).length,actions:actions.filter(a=>norm(a.outlet)===norm(o.name)).filter(a=>a.status!=='DONE').length};
  }).filter(o=>o.rows.length>0).sort((a,b)=>(b.high-a.high)|| (a.avg-b.avg));
  $('outletTable').innerHTML=outlets.map(o=>`<div class="row-card clickable" data-outlet="${esc(o.name)}"><div class="row-main"><div><div class="row-title">${esc(o.name)}</div><div class="row-sub">${o.rows.length} audit · ${o.actions} action terbuka</div></div>${o.high?statusBadge('HIGH'):o.avg>=4?statusBadge('GOOD'):statusBadge('MEDIUM')}</div><div class="mini-metrics"><span class="mini">Avg ${o.avg.toFixed(2)}</span><span class="mini">Bad ${o.bad}</span><span class="mini">Risk ${o.high}</span></div><div class="bar"><span style="width:${clamp(o.avg/5*100,0,100)}%"></span></div></div>`).join('')||'<div class="empty">Belum ada audit untuk periode ini.</div>';
  document.querySelectorAll('[data-outlet]').forEach(el=>el.addEventListener('click',()=>{if($('dashboardOutlet')){$('dashboardOutlet').value=el.dataset.outlet;renderDashboard();}}));

  const red=state.sopProgress.filter(s=>Number(s.aktual||0)<Number(s.target||0)).sort((a,b)=>(b.selisih-a.selisih)||(a.completion_percentage-b.completion_percentage)).slice(0,10);
  $('sopTable').innerHTML=red.map(s=>`<div class="row-card clickable" data-sop="${esc(s.sop_code)}"><div class="row-main"><div><div class="row-title">${esc(s.sop_code)}</div><div class="row-sub">${esc(s.sop_title)}</div></div>${statusBadge(s.status)}</div><div class="mini-metrics"><span class="mini">${s.aktual}/${s.target} indikator</span><span class="mini">Gap ${s.selisih}</span><span class="mini">${Number(s.completion_percentage||0).toFixed(1)}%</span></div><div class="bar"><span style="width:${clamp(Number(s.completion_percentage||0),0,100)}%"></span></div></div>`).join('')||'<div class="empty">Semua SOP memenuhi target master.</div>';
  document.querySelectorAll('[data-sop]').forEach(el=>el.addEventListener('click',()=>openSop(el.dataset.sop)));

  $('actionRequired').innerHTML = state.actions.filter(a=>a.status!=='DONE').sort((a,b)=>actionSla(a)==='OVERDUE'?-1:1).slice(0,8).map(a=>`<div class="row-card"><div class="row-main"><div><div class="row-title">${esc(a.outlet)} · ${esc(a.crew)}</div><div class="row-sub">${esc(a.sop_code||'—')} · ${esc(a.finding)}</div></div>${statusBadge(actionSla(a))}</div><div class="mini-metrics"><span class="mini">Priority ${esc(a.priority||'—')}</span><span class="mini">PIC ${esc(a.pic||'—')}</span><span class="mini">Due ${esc(a.due_date||'—')}</span></div></div>`).join('')||'<div class="empty">Tidak ada coaching action terbuka.</div>';

  $('lastRefresh').textContent=state.lastSync?`Sync ${state.lastSync.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}`:'Mode lokal';
}

function openSop(code){
  state.selectedSop=code;
  const s=state.sops.find(x=>x.code===code);
  if(!s) return;
  const p=state.sopProgress.find(x=>x.sop_code===code) || {target:Number(s.indicator_count||0),aktual:state.indicators.filter(i=>i.sop_code===code).length};
  const indicators=state.indicators.filter(i=>i.sop_code===code);
  $('sopDetail').innerHTML=`<div class="detail-head"><div><div class="section-kicker">SOP DETAIL</div><h2>${esc(s.title)}</h2><div class="detail-code">${esc(s.code)} · ${esc(s.category||'')}</div></div>${statusBadge(p.status||'PROSES')}</div><div class="detail-kpis"><div><strong>${p.aktual}</strong><span>Actual</span></div><div><strong>${p.target}</strong><span>Target</span></div><div><strong>${Math.max(Number(p.target)-Number(p.aktual),0)}</strong><span>Gap</span></div><div><strong>${Number(p.completion_percentage??(p.target?p.aktual/p.target*100:0)).toFixed(1)}%</strong><span>Progress</span></div></div><div class="bar big"><span style="width:${clamp(Number(p.completion_percentage??0),0,100)}%"></span></div><div class="indicator-list">${indicators.map((i,idx)=>`<div class="indicator-item"><span class="indicator-no">${idx+1}</span><span>${esc(i.indicator)}</span>${i.priority==='HIGH'?statusBadge('HIGH'):''}</div>`).join('')||'<div class="empty">Belum ada indikator master untuk SOP ini.</div>'}</div><div class="detail-actions"><button class="primary-btn" type="button" data-go-audit="${esc(s.code)}">Mulai audit SOP ini</button></div>`;
  document.querySelector('[data-go-audit]')?.addEventListener('click',()=>{
    $('sop').value=code; updateIndicators(code); switchTab('audit');
  });
  document.querySelectorAll('.sop-row').forEach(x=>x.classList.toggle('selected',x.dataset.sop===code));
}

function renderSopControl(){
  const filter=norm($('sopSearch')?.value||'');
  const rows=state.sopProgress.filter(s=>!filter||norm(s.sop_code).includes(filter)||norm(s.sop_title).includes(filter));
  $('sopControlList').innerHTML=rows.map(s=>`<div class="sop-row ${s.sop_code===state.selectedSop?'selected':''}" data-sop="${esc(s.sop_code)}"><div class="row-main"><div><div class="row-title">${esc(s.sop_code)}</div><div class="row-sub">${esc(s.sop_title)}</div></div>${statusBadge(s.status)}</div><div class="mini-metrics"><span class="mini">${s.aktual}/${s.target}</span><span class="mini">Gap ${s.selisih}</span><span class="mini">${Number(s.completion_percentage||0).toFixed(1)}%</span></div></div>`).join('')||'<div class="empty">SOP tidak ditemukan.</div>';
  document.querySelectorAll('#sopControlList .sop-row').forEach(el=>el.addEventListener('click',()=>openSop(el.dataset.sop)));
  openSop(state.selectedSop || rows[0]?.sop_code || state.sops[0]?.code);
}

function renderAuditHistory(){
  const rows=state.audits.slice(0,40);
  $('auditHistory').innerHTML=rows.map(a=>`<div class="row-card"><div class="row-main"><div><div class="row-title">${esc(a.outlet)} · ${esc(a.crew)}</div><div class="row-sub">${esc(a.sop_code)} · ${esc(a.indicator)}</div></div>${scoreBadge(a.score)}</div><div class="mini-metrics"><span class="mini">${esc(a.audit_date||'—')}</span><span class="mini">${esc(a.status||'—')}</span><span class="mini">Risk ${esc(a.risk_level||'—')}</span></div></div>`).join('')||'<div class="empty">Belum ada audit.</div>';
}

function renderCoaching(){
  const rows=[...state.actions].sort((a,b)=>(dateKey(a.due_date)||0)-(dateKey(b.due_date)||0));
  $('coachingTable').innerHTML=rows.slice(0,60).map(a=>{const sla=actionSla(a);return `<div class="row-card"><div class="row-main"><div><div class="row-title">${esc(a.crew)} · ${esc(a.outlet)}</div><div class="row-sub">${esc(a.sop_code||'—')} · ${esc(a.finding)}</div></div>${statusBadge(sla)}</div><div class="mini-metrics"><span class="mini">Prioritas ${esc(a.priority||'—')}</span><span class="mini">PIC ${esc(a.pic||'—')}</span><span class="mini">Due ${esc(a.due_date||'—')}</span><span class="mini">Status ${esc(a.status||'—')}</span></div></div>`;}).join('')||'<div class="empty">Belum ada coaching action.</div>';
}

function renderAll(){renderDashboard();renderSopControl();renderAuditHistory();renderCoaching();}

function switchTab(tab){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id==='tab-'+tab));
  const titles={audit:['Audit Lapangan','Input cepat, dependent dropdown, dan auto-diagnosis.'],dashboard:['Dashboard','Operational control center untuk outlet, SOP, risk, dan coaching.'],sop:['SOP Control','Pantau kesiapan 32 SOP dan buka detail indikator.'],coaching:['Coaching','Kelola action, PIC, due date, dan SLA follow-up.']};
  $('pageTitle').textContent=titles[tab][0]; $('pageSubtitle').textContent=titles[tab][1];
  if(tab==='sop') renderSopControl();
  if(tab==='dashboard') renderDashboard();
}

document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
$('rangeFilter').addEventListener('change',renderDashboard);
$('dashboardOutlet').addEventListener('change',renderDashboard);
$('sopSearch').addEventListener('input',renderSopControl);
$('refreshBtn').addEventListener('click',async()=>{
  if(db){
    const ok=await initDB();
    showToast(ok?'Data realtime diperbarui':'Mode lokal');
  } else showToast('Mode lokal');
  renderAll();
});
$('goAuditBtn')?.addEventListener('click',()=>switchTab('audit'));
$('goSopBtn')?.addEventListener('click',()=>switchTab('sop'));
$('installBtn').addEventListener('click',async()=>{ if(window.__deferredInstall){window.__deferredInstall.prompt();window.__deferredInstall=null;} });
$('evidence').addEventListener?.('change',()=>{});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();window.__deferredInstall=e;$('installBtn').hidden=false;});
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
window.addEventListener('online',async()=>{if(!onlineMode && cfg.SUPABASE_URL){const ok=await initDB();if(ok)await syncPending();renderAll();}});

(async function boot(){
  initLookups();
  initFormDefaults();

  const ok = await initDB();

  if(ok){
    renderAll();
    setConnection('• Realtime aktif','connection');
    await syncPending();
    renderAll();
  }else if(!db && (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.FORCE_LOCAL)){
    seedLocal();
    renderAll();
    setConnection('• Lokal / Offline','connection');
  }
})();
