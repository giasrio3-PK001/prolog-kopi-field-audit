const cfg = window.APP_CONFIG || {};
const seed = window.SEED_DATA || {sops:[], indicators:[], outlets:[], crews:[], audits:[], actions:[]};

let db = null;
let onlineMode = false;
let realtimeChannel = null;
let pendingEvidenceByIndicator = new Map();
let activeEvidenceSop = '';
const MAX_EVIDENCE_PER_INDICATOR = 10;
const MAX_EVIDENCE_FILE_BYTES = 15 * 1024 * 1024;

const state = {
  sops: seed.sops || [],
  indicators: seed.indicators || [],
  outlets: seed.outlets || [],
  crews: seed.crews || [],
  crewMasters: [],
  crewMasterError: '',
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
  const map = {LENGKAP:'ok',SELESAI:'ok',GOOD:'ok',EXCELLENT:'ok',PROSES:'warn','BELUM LENGKAP':'warn','BELUM MULAI':'bad','NOT STARTED':'bad',HIGH:'bad',MEDIUM:'warn',LOW:'ok',OPEN:'warn','ON PROGRESS':'warn',DONE:'ok',ACTIVE:'ok',AKTIF:'ok',INACTIVE:'bad',NONAKTIF:'bad',MONITOR:'warn'};
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
  if(cfg.FORCE_LOCAL || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return false;

  
try{
  if(!db){
    const mod = await import(
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
    );

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

    const {data:{session}} = await db.auth.getSession();


    if(!session?.user){
      onlineMode = false;
      showLoginScreen();
      return false;
    }
    

const sops = await db.from('sops').select('*').order('code');
if(sops.error) throw new Error('SOP: ' + sops.error.message);


const indicators = await db.from('indicators').select('*').order('sop_code').order('id');
if(indicators.error) throw new Error('INDICATORS: ' + indicators.error.message);


const outlets = await db.from('outlets').select('*').order('name');
if(outlets.error) throw new Error('OUTLETS: ' + outlets.error.message);


const crews = await db.from('current_crew_assignments').select('*').order('crew_id');
if(crews.error) throw new Error('CREWS: ' + crews.error.message);

// Data master dibaca terpisah agar crew nonaktif juga bisa ditampilkan.
// Jika SELECT tabel master dibatasi policy, aplikasi utama tetap bisa berjalan.
const crewMastersResult = await db.from('crews').select('*').order('crew_id');
if(crewMastersResult.error) console.warn('Crew master tidak dapat dibaca:', crewMastersResult.error.message);


const audits = await db.from('audits').select('*').order('created_at',{ascending:false}).limit(1000);
if(audits.error) throw new Error('AUDITS: ' + audits.error.message);


const actions = await db.from('coaching_actions').select('*').order('created_at',{ascending:false}).limit(500);
if(actions.error) throw new Error('COACHING_ACTIONS: ' + actions.error.message);
    
    state.sops = sops.data || [];
    state.indicators = indicators.data || [];
    state.outlets = outlets.data || [];
    state.crews = crews.data || [];
    state.crewMasterError = crewMastersResult.error?.message || '';
    state.crewMasters = crewMastersResult.data || [];
    if(!state.crewMasters.length && state.crews.length){
      if(!state.crewMasterError) state.crewMasterError = 'Tabel crews tidak mengembalikan baris master; daftar aktif diturunkan dari current_crew_assignments.';
      state.crewMasters = state.crews.map(c => ({
        crew_id:c.crew_id, name:c.name,
        position:c.master_position || c.assignment_position || c.position || 'Staff',
        status:c.master_status || 'Aktif'
      }));
    }
    state.audits = audits.data || [];
    state.actions = actions.data || [];
    state.sopProgress = [];
    
    if(!state.sopProgress.length) rebuildSopProgress();
    initLookups();
    state.lastSync = new Date();
    onlineMode = true;

    hideLoginScreen();
    subscribeRealtime();

    return true;
  }catch(err){
  console.warn('Supabase init gagal.', err);
  onlineMode = false;
  setConnection('• Koneksi Supabase gagal','connection');
  showLoginScreen('Supabase error: ' + (err?.message || String(err)));
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
        errorBox.textContent = 'Memproses login...';
        errorBox.style.display = 'block';

      const {error} = await db.auth.signInWithPassword({
      email,
      password
      });

      if(error) throw error;

      errorBox.textContent = 'Login Supabase berhasil, memuat data...';
      console.log('LOGIN: signInWithPassword berhasil');

      errorBox.textContent = 'Memuat data berhasil...';
      const ok = await initDB();

        if(!ok){
        return;
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
  const debugBox = $('authError');

if(debugBox && message){
  debugBox.textContent = message;
  debugBox.style.display = 'block';
}
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
    try{
      const copy = {...item}; delete copy._pending; delete copy.id; delete copy.created_at;
      const localUrls=Array.isArray(copy.evidence_urls) ? copy.evidence_urls : (copy.evidence_url ? [copy.evidence_url] : []);
      const uploadedUrls=[];
      for(const url of localUrls){
        uploadedUrls.push(typeof url==='string' && url.startsWith('data:image/') ? await uploadEvidence(url) : url);
      }
      copy.evidence_urls=uploadedUrls;
      copy.evidence_url=uploadedUrls[0] || null;
      const {data,error} = await db.from('audits').insert(copy).select().single();
      if(!error){ Object.assign(item,data); delete item._pending; }
      else console.warn('Sync audit tertunda:',error.message);
    }catch(err){console.warn('Upload/sync evidence tertunda:',err?.message||err);}
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
  const activeOutlets = state.outlets.filter(isActiveOutlet);
  setSelectOptions($('masterCrewOutlet'), activeOutlets, o=>o.name, o=>o.name, 'Pilih outlet');
  setSelectOptions($('crewMoveOutlet'), activeOutlets, o=>o.name, o=>o.name, 'Pilih outlet tujuan');
  setSelectOptions($('crewReactivateOutlet'), activeOutlets, o=>o.name, o=>o.name, 'Pilih outlet');
  updateCrewSelect('');
  updateActionCrewSelect('');
  updateIndicators('');
}

function updateCrewSelect(outlet){
  const arr = state.crews.filter(
    c => !outlet || c.outlet === outlet
  );

  setSelectOptions(
    $('crew'),
    arr,
    c => c.name,
    c => {
      const position =
        c.assignment_position ||
        c.master_position ||
        c.position ||
        '';

      return `${c.name}${position ? ' - ' + position : ''}`;
    },
    'Pilih crew'
  );

  $('position').value = '';
  $('crew').onchange = () => {
  const selected = state.crews.find(
    c => c.name === $('crew').value
  );

  $('position').value = selected
    ? (
        selected.assignment_position ||
        selected.master_position ||
        selected.position ||
        ''
      )
    : '';
};
}

function updateActionCrewSelect(outlet){
  const arr = state.crews.filter(
    c => !outlet || c.outlet === outlet
  );

  setSelectOptions(
    $('actionCrew'),
    arr,
    c => c.name,
    c => c.name,
    'Pilih crew'
  );
}

function updateIndicators(code){
  if(code !== activeEvidenceSop){
    pendingEvidenceByIndicator.clear();
    activeEvidenceSop = code || '';
  }
  const arr = state.indicators.filter(i=>i.sop_code===code);
  const host=$('indicatorAuditList');
  if(!host)return;
  host.innerHTML=arr.map((i,idx)=>`<div class="indicator-audit-card" data-indicator-card="${idx}">
    <h3>${idx+1}. ${esc(i.indicator)}</h3>${i.priority==='HIGH'?'<div class="indicator-priority">PRIORITAS HIGH</div>':''}
    <div class="score-picker">${[5,4,3,2,1].map(s=>`<button type="button" class="score-btn" data-indicator-score="${idx}" data-score="${s}">${s}</button>`).join('')}</div>
    <div class="indicator-score-summary" data-summary="${idx}"></div>
    <div class="indicator-evidence">
      <div class="indicator-evidence-title">Foto Evidence Indikator</div>
      <div class="indicator-evidence-actions">
        <button type="button" class="ghost-btn" data-evidence-camera="${idx}">📷 Ambil Foto</button>
        <button type="button" class="ghost-btn" data-evidence-gallery="${idx}">＋ Pilih dari Gallery</button>
      </div>
      <input class="evidence-file-input" type="file" accept="image/*" capture="environment" data-evidence-camera-input="${idx}" aria-label="Ambil foto indikator ${idx+1}">
      <input class="evidence-file-input" type="file" accept="image/*" multiple data-evidence-gallery-input="${idx}" aria-label="Pilih foto galeri indikator ${idx+1}">
      <div class="evidence-count" data-evidence-count="${idx}">Belum ada foto · Maksimal ${MAX_EVIDENCE_PER_INDICATOR} foto</div>
      <div class="evidence-thumbnails" data-evidence-preview="${idx}"></div>
    </div>
  </div>`).join('') || '<div class="empty">SOP ini belum memiliki indikator master.</div>';
  if($('indicatorAuditCount'))$('indicatorAuditCount').textContent=`${arr.length} indikator · Nilai dan foto diisi masing-masing indikator`;
  host.querySelectorAll('.score-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const idx=btn.dataset.indicatorScore;
    host.querySelectorAll(`.score-btn[data-indicator-score="${idx}"]`).forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    const score=Number(btn.dataset.score), summary=host.querySelector(`[data-summary="${idx}"]`);
    summary.innerHTML=`<div class="summary-box"><div class="summary-row"><span>Status</span>${statusBadge(statusFor(score))}</div><div class="summary-row"><span>Risiko</span>${statusBadge(riskFor(score))}</div><div class="summary-row"><span>Coaching</span><strong>${coachingFor(score)?'YA':'TIDAK'}</strong></div><div class="summary-row"><span>Rekomendasi</span><strong>${esc(recommendationFor(score))}</strong></div></div>`;
  }));
}

function initFormDefaults(){
  $('auditDate').value=today();
  $('auditTime').value=nowTime();
  $('actionDate').value=today();
  $('dueDate').value=today();
  $('actionDue').value=today();
}

function renderScoreSummary(score){
  const st=statusFor(score), risk=riskFor(score);
  $('scoreSummary').innerHTML=`
    <div class="summary-row"><span>Status</span>${statusBadge(st)}</div>
    <div class="summary-row"><span>Risiko</span>${statusBadge(risk)}</div>
    <div class="summary-row"><span>Butuh Coaching</span><strong>${coachingFor(score)?'YA':'TIDAK'}</strong></div>
    <div class="summary-row"><span>Rekomendasi</span><strong>${esc(recommendationFor(score))}</strong></div>`;
}

function currentRecurring(outlet,crew,sop){
  return state.audits.filter(a=>norm(a.outlet)===norm(outlet)&&norm(a.crew)===norm(crew)&&a.sop_code===sop&&Number(a.score)<=3).length>=1;
}
function recordsAuditFromForm(){
  const outlet=$('outlet').value, crew=$('crew').value, sop=$('sop').value;
  const cards=[...document.querySelectorAll('#indicatorAuditList .indicator-audit-card')];
  const indicators=state.indicators.filter(i=>i.sop_code===sop);
  const scores=cards.map(card=>Number(card.querySelector('.score-btn.active')?.dataset.score||0));
  if(!outlet||!crew||!sop||!indicators.length||scores.some(s=>s!==0&&(s<1||s>5))||!scores.some(s=>s>=1&&s<=5))return [];
  const sessionId=crypto.randomUUID();
  const recurring=currentRecurring(outlet,crew,sop);
  return indicators.map((item,idx)=>{
    const score=scores[idx];
    if(score===0)return null;
    return {
      audit_group_id:sessionId,
      audit_date:$('auditDate').value,audit_time:$('auditTime').value,
      outlet,crew,position:$('position').value,shift:$('shift').value,sop_code:sop,indicator:item.indicator,score,
      status:statusFor(score),diagnosis:score>=4?'Standar terpenuhi':score===3?'Belum konsisten — perlu coaching':'Tidak memenuhi standar — perlu perbaikan segera',
      risk_level:riskFor(score),needs_coaching:coachingFor(score),recommendation:recommendationFor(score),
      finding:$('finding').value,action:$('action').value,pic_action:$('picAction').value,due_date:$('dueDate').value,
      follow_up:$('followUp').value,auditor:$('auditor').value,root_cause:$('rootCause').value,
      root_cause_detail:$('rootCauseDetail').value,diagnosis_type:$('diagnosisType').value,recurring_issue:recurring,
      early_warning:earlyWarningFor(score,recurring),priority:score<=2?'HIGH':score===3?'MEDIUM':'LOW',
      scope:$('diagnosisType').value==='Outlet Pattern'?'Outlet-wide':$('diagnosisType').value==='Area-wide'?'Area-wide':'Individual',
      review_status:score<=3?'OPEN':'MONITOR',evidence_url:null,evidence_urls:[],_indicatorIndex:idx
    };
  }).filter(Boolean);
}
$('auditForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const records=recordsAuditFromForm();
    if(!records.length){showToast('Lengkapi identitas dan nilai minimal satu indikator SOP.');return;}

    const selectedIndexes=new Set(records.map(r=>r._indicatorIndex));
    for(const [idx,photos] of pendingEvidenceByIndicator.entries()){
      if(photos.length && !selectedIndexes.has(Number(idx))){
        showToast('Pilih nilai indikator yang memiliki foto evidence sebelum menyimpan.');
        return;
      }
    }
    if(!onlineMode && Array.from(pendingEvidenceByIndicator.values()).some(list=>list.length)){
      showToast('Foto evidence memerlukan koneksi internet. Audit tanpa foto tetap bisa disimpan offline.');
      return;
    }

    for(const rec of records){
      const photos=pendingEvidenceByIndicator.get(String(rec._indicatorIndex)) || pendingEvidenceByIndicator.get(rec._indicatorIndex) || [];
      const urls=[];
      if(onlineMode){
        for(const dataUrl of photos) urls.push(await uploadEvidence(dataUrl));
      }else{
        urls.push(...photos);
      }
      rec.evidence_urls=urls;
      rec.evidence_url=urls[0] || null; // backward compatibility with older app versions
      delete rec._indicatorIndex;
      await saveAudit(rec);
    }
    await syncPending();
    showToast(`${records.length} indikator berhasil disimpan`);
    e.target.reset();initFormDefaults();initLookups();pendingEvidenceByIndicator.clear();activeEvidenceSop='';renderAll();
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
  if(!db || !onlineMode) throw new Error('Login dan koneksi internet diperlukan untuk upload foto evidence.');
  const blob=await (await fetch(dataUrl)).blob();
  const fileName=`evidence/${Date.now()}-${crypto.randomUUID()}.jpg`;
  const {error}=await db.storage.from('audit-evidence').upload(fileName,blob,{contentType:'image/jpeg',upsert:false});
  if(error) throw error;
  return db.storage.from('audit-evidence').getPublicUrl(fileName).data.publicUrl;
}
function compressImage(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader(); reader.onload=()=>{const img=new Image(); img.onload=()=>{
      const max=1280,scale=Math.min(1,max/Math.max(img.width,img.height));
      const c=document.createElement('canvas'); c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
      const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,c.width,c.height);
      const outletEl=$('outlet'), crewEl=$('crew');
      const outletName=outletEl?.selectedOptions?.[0]?.text||outletEl?.value||'Outlet';
      const crewName=crewEl?.selectedOptions?.[0]?.text||crewEl?.value||'Crew';
      const stamp=new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())+' WIB';
      const bandH=Math.max(92,Math.round(c.height*.13));
      const pad=Math.max(16,Math.round(c.width*.025));
      ctx.fillStyle='rgba(0,0,0,.72)';ctx.fillRect(0,c.height-bandH,c.width,bandH);
      ctx.fillStyle='#fff';ctx.textBaseline='top';
      const f1=Math.max(16,Math.round(c.width*.027)), f2=Math.max(14,Math.round(c.width*.022));
      ctx.font='bold '+f1+'px Arial';ctx.fillText('PROLOG KOPI | FIELD AUDIT',pad,c.height-bandH+pad);
      ctx.font=f2+'px Arial';ctx.fillText('OUTLET: '+outletName,pad,c.height-bandH+pad+f1+6);
      ctx.fillText('CREW: '+crewName+'  |  '+stamp,pad,c.height-bandH+pad+f1+f2+12);
      resolve(c.toDataURL('image/jpeg',.75));
    }; img.onerror=reject; img.src=reader.result;}; reader.onerror=reject; reader.readAsDataURL(file);
  });
}
$('outlet').addEventListener('change',e=>updateCrewSelect(e.target.value));
$('crew').addEventListener('change',()=>{});
$('sop').addEventListener('change',e=>{
  const hasPhotos=Array.from(pendingEvidenceByIndicator.values()).some(list=>list.length);
  if(hasPhotos && !confirm('Mengganti SOP akan menghapus foto evidence yang belum disimpan. Lanjutkan?')){
    e.target.value=activeEvidenceSop;
    return;
  }
  updateIndicators(e.target.value);
});
$('actionOutlet').addEventListener('change',e=>updateActionCrewSelect(e.target.value));
$('coachingTable').addEventListener('change', async e => {
  const select = e.target.closest('.action-status');
  if (!select) return;

  const item = state.actions.find(
    a => String(a.id) === select.dataset.id
  );
  if (!item) return;

  if (!db || !onlineMode) {
    showToast('Koneksi Supabase belum aktif');
    renderAll();
    return;
  }

  try {
    const newStatus = select.value;
    const { data, error } = await db
      .from('coaching_actions')
      .update({ status: newStatus })
      .eq('id', item.id)
      .select()
      .single();

    if (error) throw error;

    Object.assign(item, data);
    showToast('Status coaching berhasil diperbarui');
    renderAll();
  } catch (err) {
    showToast('Gagal mengubah status: ' + (err?.message || 'error'));
    renderAll();
  }
});
function renderEvidencePreview(indicatorIndex){
  const host=$(`evidencePreview-${indicatorIndex}`) || document.querySelector(`[data-evidence-preview="${indicatorIndex}"]`);
  const count=$(`evidenceCount-${indicatorIndex}`) || document.querySelector(`[data-evidence-count="${indicatorIndex}"]`);
  if(!host || !count) return;
  const photos=pendingEvidenceByIndicator.get(String(indicatorIndex)) || [];
  count.textContent=`${photos.length} foto dipilih · Maksimal ${MAX_EVIDENCE_PER_INDICATOR} foto`;
  host.innerHTML=photos.map((src,photoIndex)=>`<div class="evidence-thumb">
    <a href="${esc(src)}" target="_blank" rel="noopener noreferrer"><img src="${esc(src)}" alt="Preview evidence ${photoIndex+1}"></a>
    <button type="button" class="evidence-remove" data-evidence-remove="${indicatorIndex}" data-photo-index="${photoIndex}" aria-label="Hapus foto ${photoIndex+1}">×</button>
    <span>Foto ${photoIndex+1}</span>
  </div>`).join('');
}

async function handleEvidenceFiles(input, indicatorIndex){
  const files=Array.from(input.files || []);
  if(!files.length) return;
  const key=String(indicatorIndex);
  const photos=pendingEvidenceByIndicator.get(key) || [];
  let added=0;
  try{
    for(const file of files){
      if(photos.length>=MAX_EVIDENCE_PER_INDICATOR){
        showToast(`Maksimal ${MAX_EVIDENCE_PER_INDICATOR} foto untuk setiap indikator.`);
        break;
      }
      if(!file.type || !file.type.startsWith('image/')){
        showToast(`File ${file.name} bukan gambar dan dilewati.`);
        continue;
      }
      if(file.size>MAX_EVIDENCE_FILE_BYTES){
        showToast(`File ${file.name} melebihi 15 MB dan dilewati.`);
        continue;
      }
      const compressed=await compressImage(file);
      photos.push(compressed);
      added++;
      pendingEvidenceByIndicator.set(key,photos);
      renderEvidencePreview(indicatorIndex);
    }
    if(added) showToast(`${added} foto ditambahkan ke indikator.`);
  }catch(err){
    console.error(err);
    showToast('Gagal memproses foto: '+(err.message||'error'));
  }finally{
    input.value='';
  }
}

const indicatorEvidenceHost=$('indicatorAuditList');
indicatorEvidenceHost?.addEventListener('click',e=>{
  const camera=e.target.closest('[data-evidence-camera]');
  if(camera){
    indicatorEvidenceHost.querySelector(`[data-evidence-camera-input="${camera.dataset.evidenceCamera}"]`)?.click();
    return;
  }
  const gallery=e.target.closest('[data-evidence-gallery]');
  if(gallery){
    indicatorEvidenceHost.querySelector(`[data-evidence-gallery-input="${gallery.dataset.evidenceGallery}"]`)?.click();
    return;
  }
  const remove=e.target.closest('[data-evidence-remove]');
  if(remove){
    const key=String(remove.dataset.evidenceRemove);
    const photos=pendingEvidenceByIndicator.get(key) || [];
    photos.splice(Number(remove.dataset.photoIndex),1);
    if(photos.length) pendingEvidenceByIndicator.set(key,photos);
    else pendingEvidenceByIndicator.delete(key);
    renderEvidencePreview(key);
  }
});
indicatorEvidenceHost?.addEventListener('change',e=>{
  const camera=e.target.closest('[data-evidence-camera-input]');
  const gallery=e.target.closest('[data-evidence-gallery-input]');
  const input=camera || gallery;
  if(input) handleEvidenceFiles(input, input.dataset.evidenceCameraInput ?? input.dataset.evidenceGalleryInput);
});

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
  // Compare calendar dates, not timestamps: the due date remains valid through that day.
  const dueParts=String(a.due_date).slice(0,10).split('-').map(Number);
  if(dueParts.length!==3||dueParts.some(n=>!Number.isFinite(n)))return 'OPEN';
  const dueDay=Date.UTC(dueParts[0],dueParts[1]-1,dueParts[2]);
  const now=new Date();
  const todayDay=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
  const diff=Math.round((dueDay-todayDay)/86400000);
  if(diff<0)return 'OVERDUE';
  if(diff===0)return 'DUE TODAY';
  return diff<=2?'DUE SOON':'ON TRACK';
}
function masterSummary(){
  const target=state.sops.reduce((s,x)=>s+Number(x.indicator_count||0),0);
  const actual=state.indicators.length;
  const complete=state.sopProgress.filter(x=>Number(x.aktual||0)>=Number(x.target||0)).length;
  const notStarted=state.sopProgress.filter(x=>Number(x.aktual||0)===0).length;
  return {target,actual,percent:target?actual/target*100:0,complete,notStarted};
}

function priorityGapSessionKey(a){
  const groupId=String(a.audit_group_id||'').trim();
  if(groupId)return 'group:'+groupId;
  // Legacy records without a group ID: one inspection session is inferred
  // from the audit's date/time, outlet, crew, SOP and auditor.
  return ['legacy',a.audit_date||'',a.audit_time||'',norm(a.outlet),norm(a.crew),norm(a.sop_code),norm(a.auditor)].join('|');
}

function priorityGapStatus(score){
  if(score<=2)return 'CRITICAL';
  if(score<=3)return 'HIGH';
  if(score<4)return 'MEDIUM';
  return 'GOOD';
}

function priorityGapBadge(status){
  const cls=status==='CRITICAL'?'bad':status==='HIGH'?'bad':status==='MEDIUM'?'warn':status==='GOOD'?'ok':'neutral';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function buildPriorityGapStats(audits){
  const sopByCode=new Map(state.sops.map(s=>[String(s.code),s]));
  const grouped=new Map();
  (audits||[]).forEach(a=>{
    const score=Number(a.score),code=String(a.sop_code||'');
    if(!Number.isFinite(score)||score<1||score>5||!sopByCode.has(code))return;
    if(!grouped.has(code))grouped.set(code,[]);
    grouped.get(code).push(a);
  });
  return Array.from(grouped.entries()).map(([code,records])=>{
    const sop=sopByCode.get(code);
    const score=avg(records);
    const sessions=new Set(records.map(priorityGapSessionKey));
    const outlets=new Set(records.map(a=>norm(a.outlet)).filter(Boolean));
    return {
      sop_code:code,
      sop_title:sop?.title||code,
      records,
      score,
      gap:Math.max(0,4-score),
      status:priorityGapStatus(score),
      sessions:sessions.size,
      outletCount:outlets.size,
      indicatorCount:new Set(records.map(a=>norm(a.indicator)).filter(Boolean)).size,
      criticalRatings:records.filter(a=>Number(a.score)<=2).length,
      coachingRatings:records.filter(a=>Number(a.score)<=3).length,
      recurringCount:records.filter(a=>a.recurring_issue===true||String(a.recurring_issue).toLowerCase()==='true').length
    };
  });
}

function renderPriorityGap(audits){
  const host=$('sopTable');
  if(!host)return;
  const stats=buildPriorityGapStats(audits);
  if(!stats.length){
    host.innerHTML='<div class="empty">Belum tersedia hasil audit yang valid pada periode dan outlet terpilih. Coba ubah rentang waktu atau outlet.</div>';
    return;
  }

  const count=status=>stats.filter(s=>s.status===status).length;
  const summaryCard=(label,value,color,bg,desc)=>
    `<div style="border:1px solid #eaecf0;border-radius:11px;background:${bg};padding:10px;min-width:0">`+
      `<div style="font-size:10px;font-weight:800;letter-spacing:.4px;color:${color}">${label}</div>`+
      `<div style="font-size:23px;font-weight:850;color:#101828;margin:3px 0">${value}</div>`+
      `<div style="font-size:10px;color:#667085;line-height:1.35">${desc}</div></div>`;

  const ranked=stats.filter(s=>s.status!=='GOOD').sort((a,b)=>
    (b.gap-a.gap)||
    (b.recurringCount-a.recurringCount)||
    (b.criticalRatings-a.criticalRatings)||
    (b.sessions-a.sessions)||
    a.sop_code.localeCompare(b.sop_code)
  );
  const top=ranked.slice(0,8);
  const summary=
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px">'+
      summaryCard('CRITICAL',count('CRITICAL'),'#b42318','#fff5f4','Avg score 1.00–2.00')+
      summaryCard('HIGH',count('HIGH'),'#c2410c','#fff7ed','Avg score 2.01–3.00')+
      summaryCard('MEDIUM',count('MEDIUM'),'#a16207','#fffbeb','Avg score 3.01–3.99')+
      summaryCard('GOOD',count('GOOD'),'#15803d','#f0fdf4','Avg score ≥ 4.00')+
    '</div>';
  const rangeNote=`Analisis ${stats.length} SOP yang memiliki hasil audit · Target performa 4.00/5`;
  const list=top.map((s,index)=>
    `<div class="row-card clickable" role="button" tabindex="0" data-priority-gap-sop="${esc(s.sop_code)}">`+
      `<div class="row-main"><div><div class="row-title">${index+1}. ${esc(s.sop_code)}</div><div class="row-sub">${esc(s.sop_title)}</div></div>${priorityGapBadge(s.status)}</div>`+
      `<div class="mini-metrics"><span class="mini">Avg ${s.score.toFixed(2)}/5</span><span class="mini">Gap ${s.gap.toFixed(2)}</span><span class="mini">${s.sessions} sesi</span><span class="mini">${s.outletCount} outlet</span></div>`+
      `<div class="bar"><span style="width:${clamp(s.score/5*100,0,100).toFixed(1)}%"></span></div>`+
      `<div class="row-sub">${s.criticalRatings} nilai kritis (1–2) · ${s.coachingRatings} nilai ≤3${s.sessions<3?' · Data terbatas':''}</div>`+
      '<div style="font-size:11px;font-weight:750;color:#694d35;margin-top:8px">Lihat Detail Gap →</div></div>'
  ).join('');

  host.innerHTML=summary+
    `<div style="font-size:11px;color:#667085;margin:0 0 9px">${esc(rangeNote)}</div>`+
    (list||'<div class="empty">Tidak ditemukan gap performa pada periode dan outlet terpilih. Semua SOP yang diaudit sudah mencapai target.</div>')+
    (ranked.length>8?`<div class="save-note">Menampilkan 8 dari ${ranked.length} SOP yang belum mencapai target.</div>`:'');

  host.querySelectorAll('[data-priority-gap-sop]').forEach(el=>{
    el.addEventListener('click',()=>openPriorityGapDetail(el.dataset.priorityGapSop));
    el.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();openPriorityGapDetail(el.dataset.priorityGapSop);}
    });
  });
}

function openPriorityGapDetail(sopCode){
  const rows=filterAudits().filter(a=>String(a.sop_code||'')===String(sopCode)&&Number(a.score)>=1&&Number(a.score)<=5);
  const stats=buildPriorityGapStats(rows).find(s=>s.sop_code===String(sopCode));
  if(!stats){showToast('Data audit SOP ini tidak tersedia pada filter terpilih.');return;}

  const indicators=state.indicators.filter(i=>String(i.sop_code)===String(sopCode));
  const indicatorStats=indicators.map(ind=>{
    const records=rows.filter(a=>norm(a.indicator)===norm(ind.indicator));
    return {indicator:ind.indicator,priority:ind.priority,records,score:records.length?avg(records):null};
  }).sort((a,b)=>{
    if(a.score===null&&b.score!==null)return 1;
    if(a.score!==null&&b.score===null)return -1;
    return (a.score??99)-(b.score??99);
  });

  const outletMap=new Map();
  rows.forEach(a=>{
    const key=String(a.outlet||'Tidak diketahui');
    if(!outletMap.has(key))outletMap.set(key,[]);
    outletMap.get(key).push(a);
  });
  const outlets=Array.from(outletMap.entries()).map(([name,records])=>{
    const sessions=new Set(records.map(priorityGapSessionKey));
    const score=avg(records);
    return {name,records,score,gap:Math.max(0,4-score),sessions:sessions.size};
  }).sort((a,b)=>(b.gap-a.gap)||a.name.localeCompare(b.name));

  const history=rows.slice().sort((a,b)=>
    String(b.audit_date||'').localeCompare(String(a.audit_date||''))||
    String(b.audit_time||'').localeCompare(String(a.audit_time||''))
  ).slice(0,10);
  const limited=stats.sessions<3;
  const modal=document.getElementById('priorityGapDetailModal')||document.createElement('div');
  modal.id='priorityGapDetailModal';
  modal.setAttribute('role','dialog');
  modal.setAttribute('aria-modal','true');
  modal.style.cssText='position:fixed;inset:0;z-index:99998;background:rgba(15,23,42,.68);display:flex;align-items:center;justify-content:center;padding:12px;overflow:auto;backdrop-filter:blur(3px)';

  const outletHtml=outlets.map(o=>
    `<div class="priority-gap-detail-row" style="border:1px solid #eaecf0;border-radius:11px;padding:11px;margin-bottom:8px">`+
      `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><strong>${esc(o.name)}</strong><strong>${o.score.toFixed(2)}/5</strong></div>`+
      `<div style="font-size:11px;color:#667085;margin-top:5px">Gap ${o.gap.toFixed(2)} · ${o.sessions} sesi · ${o.records.length} penilaian indikator</div>`+
      `<div class="bar" style="margin-top:8px"><span style="width:${clamp(o.score/5*100,0,100).toFixed(1)}%"></span></div>`+
      `<button type="button" class="link-btn" data-gap-outlet="${esc(o.name)}">Filter dashboard ke outlet ini →</button></div>`
  ).join('');

  const indicatorHtml=indicatorStats.map(ind=>{
    const label=ind.score===null?'BELUM DINILAI':priorityGapStatus(ind.score);
    const badge=ind.score===null?'<span class="badge neutral">BELUM DINILAI</span>':priorityGapBadge(label);
    return `<div style="border:1px solid #eaecf0;border-radius:11px;padding:10px;margin-bottom:8px">`+
      `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><strong style="font-size:13px">${esc(ind.indicator)}</strong>${badge}</div>`+
      `<div style="font-size:11px;color:#667085;margin-top:5px">`+
      (ind.score===null?'Belum ada histori penilaian':`Avg ${ind.score.toFixed(2)}/5 · ${ind.records.length} kali dinilai · ${ind.records.filter(a=>Number(a.score)<=3).length} nilai ≤3`)+
      (ind.priority==='HIGH'?' · Master priority HIGH':'')+'</div></div>';
  }).join('');

  const historyHtml=history.map(a=>
    `<div style="border:1px solid #eaecf0;border-radius:10px;padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">`+
      `<div><strong style="font-size:12px">${esc(a.audit_date||'—')} ${esc(a.audit_time||'')}</strong>`+
      `<div style="font-size:11px;color:#667085;margin-top:4px">${esc(a.outlet||'—')} · ${esc(a.crew||'—')} · ${esc(a.indicator||'—')}</div></div>`+
      `<div style="display:flex;align-items:center;gap:8px">${scoreBadge(a.score)}${a.id?`<button type="button" class="ghost-btn" data-gap-audit="${esc(a.id)}">Detail Audit</button>`:''}</div></div>`
  ).join('');

  modal.innerHTML=
    '<div style="background:#fff;color:#101828;width:100%;max-width:900px;max-height:94vh;overflow:auto;border-radius:17px;padding:clamp(15px,3vw,24px);box-shadow:0 20px 60px rgba(0,0,0,.25)">'+
      '<div style="position:sticky;top:-1px;z-index:5;background:rgba(255,255,255,.97);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0 14px;border-bottom:1px solid #eaecf0;margin-bottom:18px">'+
        '<div><div style="font-size:11px;color:#98734f;font-weight:800;letter-spacing:1px">PROLOG KOPI · OPERATIONAL GAP</div><h2 style="font-size:20px;margin:4px 0 0">Gap Analysis · '+esc(stats.sop_code)+'</h2><div style="font-size:12px;color:#667085;margin-top:4px">'+esc(stats.sop_title)+'</div></div>'+
        '<button type="button" class="primary-btn" data-gap-close>Tutup ✕</button></div>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">'+priorityGapBadge(stats.status)+(limited?'<span class="badge warn">DATA TERBATAS · '+stats.sessions+' SESI</span>':'<span class="badge ok">SAMPEL ≥ 3 SESI</span>')+'</div>'+
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:9px">'+
        '<div class="kpi"><div class="v">'+stats.score.toFixed(2)+'</div><div class="l">Avg Score / 5</div></div>'+
        '<div class="kpi"><div class="v">'+stats.gap.toFixed(2)+'</div><div class="l">Gap ke target 4.00</div></div>'+
        '<div class="kpi"><div class="v">'+stats.sessions+'</div><div class="l">Sesi audit</div></div>'+
        '<div class="kpi"><div class="v">'+stats.records.length+'</div><div class="l">Penilaian indikator</div></div>'+
        '<div class="kpi"><div class="v">'+stats.outletCount+'</div><div class="l">Outlet terdampak</div></div></div>'+
      (limited?'<div class="empty" style="margin-top:12px">Data masih terbatas. Gunakan hasil ini sebagai sinyal awal, bukan kesimpulan final performa SOP.</div>':'')+
      '<section style="margin-top:20px"><h3 style="font-size:14px;margin:0 0 10px;color:#694d35">01 · OUTLET BREAKDOWN</h3>'+(outletHtml||'<div class="empty">Belum ada data outlet.</div>')+'</section>'+
      '<section style="margin-top:20px"><h3 style="font-size:14px;margin:0 0 10px;color:#694d35">02 · INDIKATOR SOP</h3><div style="font-size:11px;color:#667085;margin-bottom:9px">Indikator diurutkan dari nilai rata-rata terendah. Indikator tanpa audit tetap ditampilkan sebagai belum dinilai.</div>'+(indicatorHtml||'<div class="empty">Master indikator belum tersedia.</div>')+'</section>'+
      '<section style="margin-top:20px"><h3 style="font-size:14px;margin:0 0 10px;color:#694d35">03 · RIWAYAT AUDIT TERAKHIR</h3>'+(historyHtml||'<div class="empty">Belum ada histori audit.</div>')+'</section></div>';

  const close=()=>{
    document.removeEventListener('keydown',onKey);
    modal.remove();
  };
  const onKey=e=>{if(e.key==='Escape')close();};
  modal.__priorityGapClose=close;
  modal.addEventListener('click',e=>{
    if(e.target===modal||e.target.closest('[data-gap-close]')){close();return;}
    const auditButton=e.target.closest('[data-gap-audit]');
    if(auditButton){
      const audit=state.audits.find(a=>String(a.id)===String(auditButton.dataset.gapAudit));
      if(audit){close();showAuditDetail(audit);}
      return;
    }
    const outletButton=e.target.closest('[data-gap-outlet]');
    if(outletButton){
      const outlet=outletButton.dataset.gapOutlet;
      const select=$('dashboardOutlet');
      if(select&&[...select.options].some(option=>option.value===outlet)){
        select.value=outlet;
        close();
        renderDashboard();
      }
    }
  });
  document.addEventListener('keydown',onKey);
  document.body.appendChild(modal);
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

  renderPriorityGap(audits);

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

function showAuditDetail(a){
  const old=document.getElementById('auditDetailModal');
  if(old){
    old.__auditClose?.();
    old.remove();
  }

  const modal=document.createElement('div');
  modal.id='auditDetailModal';
  modal.style.cssText=`
    position:fixed;
    inset:0;
    z-index:99999;
    background:rgba(15,23,42,.68);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:12px;
    overflow:auto;
    backdrop-filter:blur(3px);
  `;

  const cards=items=>items
    .filter(([k,v])=>v!==null && v!==undefined && String(v).trim()!=='')
    .map(([k,v])=>`
      <div style="
        background:#f8fafc;
        border:1px solid #eaecf0;
        border-radius:11px;
        padding:12px;
        min-width:0;
      ">
        <div style="font-size:11px;color:#667085;font-weight:700;margin-bottom:5px">
          ${esc(k)}
        </div>
        <div style="font-size:14px;color:#101828;font-weight:650;white-space:pre-wrap;overflow-wrap:anywhere">
          ${esc(v)}
        </div>
      </div>
    `).join('');

  const section=(title,items)=>{
    const content=cards(items);
    return content ? `
      <section style="margin-top:20px">
        <h3 style="font-size:14px;margin:0 0 10px;color:#694d35">
          ${title}
        </h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:9px">
          ${content}
        </div>
      </section>
    ` : '';
  };

  const evidenceUrls = Array.isArray(a.evidence_urls) && a.evidence_urls.length
    ? a.evidence_urls.filter(url=>typeof url==='string' && url.trim())
    : (a.evidence_url ? [a.evidence_url] : []);
  const photo = evidenceUrls.length ? `
    <div style="margin-bottom:20px">
      <div style="font-size:13px;font-weight:800;margin-bottom:9px">
        FOTO BUKTI LAPANGAN · ${evidenceUrls.length} FOTO
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,150px),1fr));gap:10px">
        ${evidenceUrls.map((url,idx)=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Buka foto evidence ${idx+1}">
          <img src="${esc(url)}" alt="Foto bukti audit ${idx+1}" loading="lazy" style="display:block;width:100%;height:150px;object-fit:cover;background:#f2f4f7;border:1px solid #eaecf0;border-radius:12px">
        </a>`).join('')}
      </div>
      <div style="font-size:11px;color:#667085;margin-top:6px">Ketuk foto untuk melihat ukuran penuh.</div>
    </div>
  ` : `
    <div style="
      padding:18px;
      background:#f8fafc;
      border:1px dashed #d0d5dd;
      border-radius:12px;
      color:#667085;
      margin-bottom:18px;
      text-align:center;
    ">
      Belum ada foto bukti untuk audit ini.
    </div>
  `;

  modal.innerHTML=`
    <div style="
      background:#fff;
      color:#101828;
      width:100%;
      max-width:760px;
      max-height:94vh;
      overflow:auto;
      border-radius:17px;
      padding:clamp(15px,3vw,24px);
      box-shadow:0 20px 60px rgba(0,0,0,.25);
    ">

      <div style="
        position:sticky;
        top:-1px;
        z-index:5;
        background:rgba(255,255,255,.97);
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        padding:5px 0 14px;
        border-bottom:1px solid #eaecf0;
        margin-bottom:18px;
      ">
        <div>
          <div style="font-size:11px;color:#98734f;font-weight:800;letter-spacing:1px">
            PROLOG KOPI · FIELD AUDIT
          </div>
          <h2 style="font-size:20px;margin:4px 0 0">
            Detail Audit
          </h2>
        </div>
        <button id="closeAuditDetail" type="button" style="
          border:0;
          background:#111827;
          color:#fff;
          padding:11px 16px;
          border-radius:9px;
          font-weight:800;
          cursor:pointer;
        ">Tutup ✕</button>
      </div>

      <div style="font-size:17px;font-weight:800;margin-bottom:5px">
        ${esc(a.outlet||'—')} · ${esc(a.crew||'—')}
      </div>

      <div style="display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 18px">
        <span style="background:#f2f4f7;padding:6px 10px;border-radius:20px;font-size:12px">
          Nilai: <b>${esc(a.score??'—')}</b>
        </span>
        <span style="background:#f2f4f7;padding:6px 10px;border-radius:20px;font-size:12px">
          Status: <b>${esc(a.status||'—')}</b>
        </span>
        <span style="background:#f2f4f7;padding:6px 10px;border-radius:20px;font-size:12px">
          Risk: <b>${esc(a.risk_level||'—')}</b>
        </span>
      </div>

      ${photo}

      ${section('01 · IDENTITAS AUDIT',[
        ['Tanggal',a.audit_date],
        ['Jam',a.audit_time],
        ['Outlet',a.outlet],
        ['Crew',a.crew],
        ['Jabatan',a.position],
        ['Shift',a.shift],
        ['Auditor',a.auditor]
      ])}

      ${section('02 · HASIL PENILAIAN',[
        ['SOP',a.sop_code],
        ['Indikator',a.indicator],
        ['Nilai Audit',a.score],
        ['Status',a.status],
        ['Risk Level',a.risk_level],
        ['Diagnosis',a.diagnosis],
        ['Tipe Diagnosis',a.diagnosis_type],
        ['Rekomendasi',a.recommendation]
      ])}

      ${section('03 · TEMUAN DAN ANALISIS',[
        ['Temuan Lapangan',a.finding],
        ['Root Cause',a.root_cause],
        ['Detail Root Cause',a.root_cause_detail],
        ['Recurring Issue',a.recurring_issue?'Ya':'Tidak'],
        ['Early Warning',a.early_warning]
      ])}

      ${section('04 · TINDAK LANJUT',[
        ['Action / Coaching',a.action],
        ['PIC Action',a.pic_action],
        ['Due Date',a.due_date],
        ['Follow-up',a.follow_up],
        ['Priority',a.priority],
        ['Review Status',a.review_status]
      ])}

      <div style="
        border-top:1px solid #eaecf0;
        margin-top:22px;
        padding-top:14px;
        font-size:11px;
        color:#667085;
        text-align:center;
      ">
        PROLOG KOPI · FIELD AUDIT OPERATIONAL CONTROL
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const close=()=>{
    document.removeEventListener('keydown',onKey);
    modal.remove();
  };

  const onKey=e=>{
    if(e.key==='Escape') close();
  };

  modal.__auditClose=close;

  modal.addEventListener('click',e=>{
    if(e.target===modal || e.target.closest('#closeAuditDetail')){
      close();
    }
  });

  document.addEventListener('keydown',onKey);
}

function renderAuditHistory(){
  const rows=state.audits.slice(0,40);

  $('auditHistory').innerHTML=rows.map(a=>`
    <div class="row-card" data-audit-id="${esc(a.id)}"
      style="cursor:pointer">
      <div class="row-main">
        <div>
          <div class="row-title">${esc(a.outlet)} · ${esc(a.crew)}</div>
          <div class="row-sub">${esc(a.sop_code)} · ${esc(a.finding||a.indicator||'')}</div>
        </div>
        ${scoreBadge(a.score)}
      </div>

      <div class="mini-metrics">
        <span class="mini">${esc(a.audit_date||'—')}</span>
        <span class="mini">${esc(a.status||'—')}</span>
        <span class="mini">Risk ${esc(a.risk_level||'—')}</span>
        <span class="mini">Lihat Detail ↗</span>
      </div>
    </div>
  `).join('')||'<div class="empty">Belum ada audit.</div>';

  $('auditHistory').querySelectorAll('[data-audit-id]').forEach(el=>{
    el.addEventListener('click',()=>{
      const a=state.audits.find(x=>String(x.id)===String(el.dataset.auditId));
      if(a) showAuditDetail(a);
    });
  });
}


function renderCoaching(){
  const rows = [...state.actions].sort(
    (a,b) => (dateKey(a.due_date)||0) - (dateKey(b.due_date)||0)
  );

  $('coachingTable').innerHTML = rows.slice(0,60).map(a => {
    const sla = actionSla(a);

    return `<div class="row-card">
      <div class="row-main">
        <div>
          <div class="row-title">${esc(a.crew)} · ${esc(a.outlet)}</div>
          <div class="row-sub">${esc(a.sop_code||'—')} · ${esc(a.finding)}</div>
        </div>
        ${statusBadge(sla)}
      </div>
      <div class="mini-metrics">
        <span class="mini">Prioritas ${esc(a.priority||'—')}</span>
        <span class="mini">PIC ${esc(a.pic||'—')}</span>
        <span class="mini">Due ${esc(a.due_date||'—')}</span>
        <span class="mini">Status
          <select class="action-status" data-id="${esc(a.id)}">
            <option value="OPEN" ${a.status==='OPEN'?'selected':''}>OPEN</option>
            <option value="ON PROGRESS" ${a.status==='ON PROGRESS'?'selected':''}>ON PROGRESS</option>
            <option value="DONE" ${a.status==='DONE'?'selected':''}>DONE</option>
          </select>
        </span>
      </div>
    </div>`;
  }).join('') || '<div class="empty">Belum ada coaching action.</div>';
}


function isActiveOutlet(outlet){
  const status = norm(outlet?.status || 'ACTIVE');
  return status === 'active' || status === 'aktif' || status === '';
}
function isActiveCrewStatus(status){
  const s = norm(status);
  return s === 'aktif' || s === 'active' || s === 'aktif aktif' || s === '1';
}
function currentAssignmentFor(crewId){
  return state.crews.find(c => String(c.crew_id) === String(crewId)) || null;
}
function nextCrewId(){
  const ids = [...state.crewMasters, ...state.crews]
    .map(c => String(c.crew_id || '').match(/^CR-(\d+)$/i))
    .filter(Boolean).map(m => Number(m[1]));
  return `CR-${String(Math.max(0, ...ids) + 1).padStart(3, '0')}`;
}
function resetOutletMasterForm(){
  const form = $('outletMasterForm');
  if(!form) return;
  form.reset();
  $('masterOutletOriginalName').value = '';
  $('masterOutletName').disabled = false;
  $('outletFormTitle').textContent = 'Tambah Outlet';
  $('outletSaveBtn').textContent = 'Simpan Outlet';
  $('outletCancelBtn').hidden = true;
}
function startOutletEdit(name){
  const outlet = state.outlets.find(o => String(o.name) === String(name));
  if(!outlet) return;
  $('masterOutletOriginalName').value = outlet.name;
  $('masterOutletName').value = outlet.name;
  $('masterOutletName').disabled = true; // Nama adalah referensi di audit/penempatan; jangan rename melalui form ini.
  $('masterOutletAddress').value = outlet.address || '';
  $('masterOutletPhoto').value = outlet.photo_path || '';
  $('masterOutletLatitude').value = outlet.latitude ?? '';
  $('masterOutletLongitude').value = outlet.longitude ?? '';
  $('masterOutletNotes').value = outlet.notes || '';
  $('outletFormTitle').textContent = `Edit Outlet · ${outlet.name}`;
  $('outletSaveBtn').textContent = 'Simpan Perubahan';
  $('outletCancelBtn').hidden = false;
  $('outletMasterForm').scrollIntoView({behavior:'smooth', block:'start'});
}
function renderMasterOutlets(){
  const list = $('masterOutletList');
  if(!list) return;
  const q = norm($('masterOutletSearch')?.value || '');
  const rows = state.outlets.filter(o => !q || [o.name,o.address,o.notes,o.status].some(v=>norm(v).includes(q)))
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
  list.innerHTML = rows.map(o => {
  const active = isActiveOutlet(o);
  const photoPath = String(o.photo_path || '').trim();
  const photoUrl = /^https?:\/\//i.test(photoPath)
  ? photoPath
  : (photoPath ? db.storage.from('outlet-photos').getPublicUrl(photoPath).data.publicUrl : '');

  const photo = photoUrl
  ? `<img class="master-outlet-photo" src="${esc(photoUrl)}" alt="Foto ${esc(o.name)}" loading="lazy" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('div'),{className:'master-outlet-photo master-no-photo',textContent:'PK'}))">`
  : `<div class="master-outlet-photo master-no-photo">PK</div>`;
    return `<article class="master-row">
      <div class="master-row-main">${photo}<div class="master-row-copy"><div class="master-row-title">${esc(o.name)}</div>
      <div class="master-row-sub">${esc(o.address||'Alamat belum diisi')}</div>
      <div class="master-row-sub">${o.latitude!=null && o.longitude!=null ? `Koordinat: ${esc(o.latitude)}, ${esc(o.longitude)} · ` : ''}${esc(o.notes||'')}</div>
      <div class="master-row-meta">${statusBadge(active?'ACTIVE':'INACTIVE')}</div></div></div>
      <div class="master-row-actions"><button type="button" class="ghost-btn" data-outlet-edit="${esc(o.name)}">Edit</button>
      <button type="button" class="${active?'danger-btn':'primary-btn'} small-btn" data-outlet-toggle="${esc(o.name)}">${active?'Nonaktifkan':'Aktifkan'}</button></div>
    </article>`;
  }).join('') || '<div class="empty">Outlet tidak ditemukan.</div>';
}
function crewMasterRows(){
  const assignmentMap = new Map(state.crews.map(c => [String(c.crew_id), c]));
  const masters = state.crewMasters.length ? state.crewMasters : state.crews;
  return masters.map(m => {
    const assignment = assignmentMap.get(String(m.crew_id)) || null;
    const status = m.status || m.master_status || '';
    const hasAssignment = Boolean(assignment);
    const active = hasAssignment || isActiveCrewStatus(status);
    return {
      ...m,
      crew_id:m.crew_id,
      name:m.name || assignment?.name || '',
      status,
      active,
      hasAssignment,
      outlet:assignment?.outlet || m.outlet || '',
      position:assignment?.assignment_position || assignment?.master_position || m.position || 'Staff',
      start_date:assignment?.start_date || ''
    };
  }).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
}
function renderMasterCrews(){
  const list = $('masterCrewList');
  if(!list) return;
  const q = norm($('masterCrewSearch')?.value || '');
  const filter = $('masterCrewStatusFilter')?.value || 'ALL';
  const rows = crewMasterRows().filter(c => {
    const matchText = !q || [c.crew_id,c.name,c.outlet,c.position,c.status].some(v=>norm(v).includes(q));
    const matchStatus = filter === 'ALL' || (filter === 'ACTIVE' ? c.active : !c.active);
    return matchText && matchStatus;
  });
  const sourceWarning = state.crewMasterError
    ? `<div class="master-notice warning">Tabel master crew tidak dapat dibaca langsung: ${esc(state.crewMasterError)}. Daftar ini hanya menampilkan crew yang bisa dibaca aplikasi.</div>` : '';
  list.innerHTML = sourceWarning + rows.map(c => {
    const statusText = c.hasAssignment ? 'AKTIF' : c.active ? 'AKTIF · BELUM ADA PENEMPATAN' : 'NONAKTIF';
    const status = c.hasAssignment ? statusBadge('ACTIVE') : c.active ? statusBadge('MONITOR') : statusBadge('INACTIVE');
    let actions = `<button type="button" class="ghost-btn" data-crew-edit="${esc(c.crew_id)}">Edit Nama</button>`;
    if(c.hasAssignment){
      actions += ` <button type="button" class="ghost-btn" data-crew-roll="${esc(c.crew_id)}">Pindah Outlet</button>
        <button type="button" class="danger-btn small-btn" data-crew-deactivate="${esc(c.crew_id)}">Nonaktifkan</button>`;
    } else if(!c.active){
      actions += ` <button type="button" class="primary-btn small-btn" data-crew-reactivate="${esc(c.crew_id)}">Aktifkan</button>`;
    }
    return `<article class="master-row"><div class="master-row-copy"><div class="master-row-title">${esc(c.name)} <span class="master-id">${esc(c.crew_id)}</span></div>
      <div class="master-row-sub">${esc(c.outlet||'Belum ada outlet')} · ${esc(c.position||'Staff')}</div>
      <div class="master-row-meta">${status}<span class="master-status-text">${esc(statusText)}</span></div></div>
      <div class="master-row-actions">${actions}</div></article>`;
  }).join('') || '<div class="empty">Crew tidak ditemukan untuk filter ini.</div>';

  const current = crewMasterRows().filter(c=>c.hasAssignment);
  const inactive = crewMasterRows().filter(c=>!c.hasAssignment && !c.active);
  const moveSelect = $('crewMoveCrew');
  const reactivateSelect = $('crewReactivateCrew');
  const oldMove = moveSelect?.value || '';
  const oldReactivate = reactivateSelect?.value || '';
  setSelectOptions(moveSelect, current, c=>c.crew_id, c=>`${c.name} · ${c.outlet||'Outlet tidak diketahui'}`, 'Pilih crew aktif');
  setSelectOptions(reactivateSelect, inactive, c=>c.crew_id, c=>`${c.name} · ${c.crew_id}`, 'Pilih crew nonaktif');
  if(moveSelect && current.some(c=>String(c.crew_id)===oldMove)) moveSelect.value = oldMove;
  if(reactivateSelect && inactive.some(c=>String(c.crew_id)===oldReactivate)) reactivateSelect.value = oldReactivate;
  if($('masterCrewId') && !$('masterCrewId').value) $('masterCrewId').value = nextCrewId();
  const note = $('crewListNote');
  if(note) note.textContent = `${crewMasterRows().length} crew master · ${current.length} dengan penempatan aktif · ${inactive.length} nonaktif`;
}
function renderMasterData(){
  renderMasterOutlets();
  renderMasterCrews();
}
async function refreshMasterData(){
  if(!db || !onlineMode) throw new Error('Koneksi Supabase belum aktif. Login dulu sebelum mengubah Master Data.');
  const [outletsResult, assignmentsResult, mastersResult] = await Promise.all([
    db.from('outlets').select('*').order('name'),
    db.from('current_crew_assignments').select('*').order('crew_id'),
    db.from('crews').select('*').order('crew_id')
  ]);
  if(outletsResult.error) throw new Error('Membaca outlet: ' + outletsResult.error.message);
  if(assignmentsResult.error) throw new Error('Membaca penempatan crew: ' + assignmentsResult.error.message);
  state.outlets = outletsResult.data || [];
  state.crews = assignmentsResult.data || [];
  state.crewMasterError = mastersResult.error?.message || '';
  state.crewMasters = mastersResult.data || [];
  if(!state.crewMasters.length && state.crews.length){
    if(!state.crewMasterError) state.crewMasterError = 'Tabel crews tidak mengembalikan baris master; daftar aktif diturunkan dari current_crew_assignments.';
    state.crewMasters = state.crews.map(c=>({crew_id:c.crew_id,name:c.name,position:c.master_position||c.assignment_position||c.position||'Staff',status:c.master_status||'Aktif'}));
  }
  initLookups();
  renderMasterData();
  renderAll();
}
async function runCrewRpc(functionName, args, successText){
  if(!db || !onlineMode) throw new Error('Koneksi Supabase belum aktif. Login dulu.');
  const {data,error} = await db.rpc(functionName,args);
  if(error) throw error;
  if(data && typeof data === 'object' && data.success === false){
    throw new Error(data.message || data.error || 'Operasi crew ditolak oleh database.');
  }
  await refreshMasterData();
  showToast(successText || data?.message || 'Data crew berhasil diperbarui.');
}
function resetCrewEditForm(){
  $('crewEditForm')?.reset();
  if($('crewEditCard')) $('crewEditCard').hidden = true;
}
function startCrewEdit(crewId){
  const crew = state.crewMasters.find(c=>String(c.crew_id)===String(crewId)) || crewMasterRows().find(c=>String(c.crew_id)===String(crewId));
  if(!crew) return;
  $('crewEditId').value = crew.crew_id;
  $('crewEditName').value = crew.name || '';
  $('crewEditCard').hidden = false;
  $('crewEditCard').scrollIntoView({behavior:'smooth',block:'start'});
}
function setMasterView(view){
  const showOutlets = view === 'outlets';
  $('masterOutletPanel').hidden = !showOutlets;
  $('masterCrewPanel').hidden = showOutlets;
  document.querySelectorAll('.master-view-btn').forEach(b=>b.classList.toggle('active',b.dataset.masterView===view));
  if(!showOutlets) renderMasterCrews(); else renderMasterOutlets();
}

// ================= CREW PERFORMANCE =================
let selectedPerformanceCrew = '';

function performanceAuditDate(a){
  const value = a.audit_date || a.created_at || '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
function performanceAuditLabel(a){
  const date = a.audit_date || (a.created_at ? String(a.created_at).slice(0,10) : '');
  const time = a.audit_time || (a.created_at ? String(a.created_at).slice(11,16) : '');
  return `${date || 'Tanggal tidak tercatat'}${time ? ` · ${time}` : ''}`;
}
function performanceFilteredAudits(name){
  const period = $('crewPerformancePeriod')?.value || 'all';
  const outlet = $('crewPerformanceOutlet')?.value || 'ALL';
  const cutoff = period === 'all' ? 0 : Date.now() - Number(period) * 86400000;
  return state.audits.filter(a => {
    if(norm(a.crew) !== norm(name)) return false;
    if(outlet !== 'ALL' && norm(a.outlet) !== norm(outlet)) return false;
    const stamp = performanceAuditDate(a);
    return !cutoff || (stamp && stamp >= cutoff);
  }).sort((a,b)=>performanceAuditDate(b)-performanceAuditDate(a));
}
function crewPerformanceData(name){
  const audits = performanceFilteredAudits(name);
  const indicatorStats = state.indicators.map((indicator, index) => {
    const records = audits.filter(a => a.sop_code === indicator.sop_code && norm(a.indicator) === norm(indicator.indicator));
    const average = avg(records);
    const good = records.filter(a => Number(a.score) >= 4).length;
    const coaching = records.filter(a => Number(a.score) <= 3).length;
    const critical = records.filter(a => Number(a.score) <= 2).length;
    return {
      id:indicator.id ?? `${indicator.sop_code}-${index}`,
      sop_code:indicator.sop_code,
      indicator:indicator.indicator,
      priority:indicator.priority,
      records,
      count:records.length,
      average,
      good,
      coaching,
      critical,
      rated:records.length > 0,
      status:!records.length ? 'BELUM DINILAI' : average >= 4 ? 'BAIK' : average <= 3 ? 'COACHING' : 'MONITOR'
    };
  });
  const sopRows = state.sops.map(sop => {
    const indicators = indicatorStats.filter(i => i.sop_code === sop.code);
    const assessed = indicators.filter(i => i.rated);
    const records = audits.filter(a => a.sop_code === sop.code);
    const goodIndicators = assessed.filter(i => i.average >= 4).length;
    const coachingIndicators = assessed.filter(i => i.average <= 3).length;
    const monitorIndicators = assessed.filter(i => i.average > 3 && i.average < 4).length;
    const target = indicators.length || Number(sop.indicator_count || 0);
    return {
      code:sop.code,
      title:sop.title,
      indicators,
      assessed:assessed.length,
      target,
      unassessed:Math.max(target-assessed.length,0),
      records,
      ratingCount:records.length,
      average:avg(records),
      goodIndicators,
      coachingIndicators,
      monitorIndicators,
      coverage:target ? assessed.length/target*100 : 0
    };
  }).filter(sop => sop.target || sop.ratingCount)
    .sort((a,b)=>a.code.localeCompare(b.code,undefined,{numeric:true}));
  const ratedIndicators = indicatorStats.filter(i=>i.rated);
  const goodIndicators = ratedIndicators.filter(i=>i.average>=4);
  const coachingIndicators = ratedIndicators.filter(i=>i.average<=3);
  const monitorIndicators = ratedIndicators.filter(i=>i.average>3&&i.average<4);
  const sessionsMap = new Map();
  audits.forEach(a=>{
    const fallbackKey=[a.audit_date||'',a.audit_time||'',a.outlet||'',a.sop_code||''].join('|');
    const key=a.audit_group_id || fallbackKey;
    if(!sessionsMap.has(key))sessionsMap.set(key,[]);
    sessionsMap.get(key).push(a);
  });
  const sessions=Array.from(sessionsMap.values()).map(records=>({
    date:records[0].audit_date || (records[0].created_at?String(records[0].created_at).slice(0,10):''),
    outlet:records[0].outlet||'',
    sop_code:records[0].sop_code||'',
    score:avg(records),
    indicators:records.length,
    timestamp:Math.max(...records.map(performanceAuditDate))
  })).sort((a,b)=>a.timestamp-b.timestamp).slice(-8);
  return {
    audits,
    indicatorStats,
    sopRows,
    sessions,
    score:avg(audits),
    ratingCount:audits.length,
    ratedIndicators:ratedIndicators.length,
    totalIndicators:state.indicators.length,
    goodIndicators,
    coachingIndicators,
    monitorIndicators,
    sopAssessed:sopRows.filter(s=>s.ratingCount>0).length,
    sopTotal:state.sops.length,
    criticalRatings:audits.filter(a=>Number(a.score)<=2).length
  };
}
function renderCrewPerformance(){
  const list=$('crewPerformanceList');
  if(!list)return;
  const period=$('crewPerformancePeriod');
  const outletSelect=$('crewPerformanceOutlet');
  if(outletSelect){
    const previous=outletSelect.value||'ALL';
    outletSelect.innerHTML='<option value="ALL">Semua outlet</option>'+state.outlets.map(o=>`<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('');
    outletSelect.value=[...outletSelect.options].some(o=>o.value===previous)?previous:'ALL';
  }
  const query=norm($('crewPerformanceSearch')?.value||'');
  const selectedOutlet=outletSelect?.value||'ALL';
  const roster=new Map();
  // Outlet tertentu: tampilkan hanya crew dengan penempatan aktif/current di outlet itu.
  // Semua outlet: roster aktif + crew historis yang belum tercatat di roster.
  const masterRoster=crewMasterRows();
  const scopedRoster=selectedOutlet==='ALL'
    ? masterRoster
    : masterRoster.filter(c=>c.hasAssignment && String(c.outlet)===String(selectedOutlet));
  scopedRoster.forEach(c=>{if(c.name)roster.set(norm(c.name),c);});
  if(selectedOutlet==='ALL') state.audits.forEach(a=>{
    const key=norm(a.crew);
    if(key&&!roster.has(key))roster.set(key,{name:a.crew,outlet:a.outlet||'',position:a.position||'',status:'Riwayat audit'});
  });
  const rows=Array.from(roster.values()).map(c=>({...c,performance:crewPerformanceData(c.name)}))
    .filter(c=>!query||[c.name,c.crew_id,c.outlet,c.position,c.status].some(v=>norm(v).includes(query)))
    .sort((a,b)=>{
      const av=a.performance.ratingCount?a.performance.score:-1;
      const bv=b.performance.ratingCount?b.performance.score:-1;
      return bv-av || String(a.name).localeCompare(String(b.name));
    });
  list.innerHTML=rows.map(c=>{
    const p=c.performance;
    const noData=!p.ratingCount;
    const score=noData?'—':p.score.toFixed(2);
    const coverage=`${p.ratedIndicators}/${p.totalIndicators}`;
    return `<article class="crew-performance-card">
      <div class="crew-performance-card-head">
        <div class="crew-performance-identity">
          <strong>${esc(c.name)}</strong>${c.crew_id?`<span class="master-id">${esc(c.crew_id)}</span>`:''}
          <div class="row-sub">${esc(c.outlet||'Outlet tidak tercatat')} · ${esc(c.position||'Jabatan tidak tercatat')}</div>
          ${c.active===false?'<span class="badge neutral">NONAKTIF · RIWAYAT TETAP ADA</span>':''}
        </div>
        <div class="crew-performance-score"><strong>${score}</strong><small>Rata-rata / 5</small></div>
      </div>
      <div class="crew-performance-metrics">
        <span class="mini">${coverage} indikator dinilai</span>
        <span class="mini">${p.goodIndicators.length} indikator baik</span>
        <span class="mini">${p.coachingIndicators.length} perlu coaching</span>
        <span class="mini">${p.sopAssessed}/${p.sopTotal} SOP dinilai</span>
      </div>
      ${noData?'<div class="performance-no-data">Belum ada penilaian pada periode/filter ini.</div>':`<div class="bar"><span style="width:${clamp(p.score/5*100,0,100)}%"></span></div><div class="row-sub">${p.ratingCount} hasil penilaian · ${p.criticalRatings} nilai kritis (1–2)</div>`}
      <button class="ghost-btn small-btn performance-open-btn" type="button" data-performance-open="${esc(c.name)}">Buka Performance Profile →</button>
    </article>`;
  }).join('')||'<div class="empty">Crew tidak ditemukan.</div>';

  if(selectedPerformanceCrew && roster.has(norm(selectedPerformanceCrew))){
    renderCrewPerformanceDetail(selectedPerformanceCrew);
  }else if($('crewPerformanceDetail')){
    $('crewPerformanceDetail').innerHTML='<div class="empty">Pilih crew untuk melihat analisis seluruh SOP dan indikator.</div>';
  }
}
function renderCrewPerformanceDetail(name){
  const host=$('crewPerformanceDetail');
  if(!host)return;
  const p=crewPerformanceData(name);
  const crew=crewMasterRows().find(c=>norm(c.name)===norm(name));
  const best=p.sopRows.filter(s=>s.ratingCount&&s.average>=4).sort((a,b)=>b.average-a.average).slice(0,5);
  const priority=p.sopRows.filter(s=>s.ratingCount&&s.average<4).sort((a,b)=>a.average-b.average).slice(0,8);
  const showSopList=(rows,emptyText)=>rows.length?rows.map(s=>`<div class="performance-highlight-row"><div><strong>${esc(s.code)}</strong><span>${esc(s.title)}</span></div><b class="${s.average>=4?'performance-good':'performance-bad'}">${s.average.toFixed(2)} / 5</b></div>`).join(''):`<div class="empty">${emptyText}</div>`;
  const trendHtml=p.sessions.length?p.sessions.map(session=>`<div class="performance-trend-row"><div><strong>${esc(session.date||'Tanggal tidak tercatat')}</strong><small>${esc(session.sop_code)} · ${esc(session.outlet)} · ${session.indicators} indikator</small></div><div class="performance-trend-value"><b>${session.score.toFixed(2)}</b><div class="bar"><span style="width:${clamp(session.score/5*100,0,100)}%"></span></div></div></div>`).join(''):'<div class="empty">Belum ada histori audit pada periode/filter ini.</div>';
  const sopHtml=p.sopRows.map(s=>{
    const indicatorHtml=s.indicators.map((i,index)=>{
      const label=i.rated?`<span class="badge ${i.average>=4?'ok':i.average<=3?'bad':'warn'}">AVG ${i.average.toFixed(2)} · ${i.status}</span>`:'<span class="badge neutral">BELUM DINILAI</span>';
      const history=i.records.map(a=>`<div class="performance-history-entry"><div><strong>${esc(performanceAuditLabel(a))}</strong><small>${esc(a.outlet||'Outlet tidak tercatat')} · ${esc(a.shift||'Shift tidak tercatat')} · Auditor ${esc(a.auditor||'—')}</small></div><div class="performance-history-score">${scoreBadge(Number(a.score||0))}</div><button class="link-btn" type="button" data-performance-audit="${esc(a.id)}">Lihat audit & evidence</button></div>`).join('');
      return `<div class="performance-indicator-row"><div class="performance-indicator-copy"><strong>${index+1}. ${esc(i.indicator)}</strong>${i.priority==='HIGH'?'<span class="badge bad">PRIORITAS HIGH</span>':''}<small>${i.count?`${i.count} kali dinilai · ${i.good} nilai baik · ${i.coaching} perlu coaching${i.critical?` · ${i.critical} nilai kritis`:''}`:'Belum ada histori penilaian'}</small></div>${label}${i.rated?`<details class="performance-history"><summary>Lihat riwayat ${i.count} penilaian</summary>${history}</details>`:''}</div>`;
    }).join('');
    const status=s.ratingCount?(s.average>=4?'BAIK':s.average<=3?'BUTUH COACHING':'MONITOR'):'BELUM DINILAI';
    const badge=s.ratingCount?`<span class="badge ${s.average>=4?'ok':s.average<=3?'bad':'warn'}">${status}</span>`:'<span class="badge neutral">BELUM DINILAI</span>';
    return `<details class="performance-sop-card"><summary class="performance-sop-summary"><div class="performance-sop-title"><strong>${esc(s.code)}</strong><span>${esc(s.title)}</span>${badge}</div><div class="performance-sop-stat"><strong>${s.ratingCount?s.average.toFixed(2):'—'}</strong><small>Rata-rata / 5</small><span>${s.assessed}/${s.target} indikator</span></div></summary><div class="performance-sop-body"><div class="performance-sop-meta"><span class="mini">${s.goodIndicators} indikator baik</span><span class="mini">${s.coachingIndicators} perlu coaching</span><span class="mini">${s.monitorIndicators} monitor</span><span class="mini">${s.unassessed} belum dinilai</span><span class="mini">${s.ratingCount} hasil audit indikator</span></div><div class="bar"><span style="width:${clamp(s.coverage,0,100)}%"></span></div><small class="performance-coverage-label">Cakupan indikator crew pada SOP ini: ${s.coverage.toFixed(0)}%</small><div class="performance-indicator-list">${indicatorHtml||'<div class="empty">Belum ada indikator master pada SOP ini.</div>'}</div></div></details>`;
  }).join('');
  host.innerHTML=`<div class="crew-profile-top"><div><div class="section-kicker">INDIVIDUAL PERFORMANCE PROFILE</div><h2>${esc(name)}</h2><div class="row-sub">${esc(crew?.outlet||'Histori lintas outlet')} · ${esc(crew?.position||'Penempatan sebelumnya ikut dihitung dari histori audit')}</div><div class="row-sub">Periode: ${$('crewPerformancePeriod')?.selectedOptions?.[0]?.text||'Semua histori'} · Outlet filter: ${$('crewPerformanceOutlet')?.selectedOptions?.[0]?.text||'Semua outlet'}</div></div><div class="crew-profile-score"><strong>${p.ratingCount?p.score.toFixed(2):'—'}</strong><span>Rata-rata / 5</span></div></div>
    <div class="crew-performance-kpis"><div><strong>${p.ratingCount}</strong><span>Hasil penilaian</span></div><div><strong>${p.ratedIndicators}/${p.totalIndicators}</strong><span>Indikator pernah dinilai</span></div><div><strong>${p.goodIndicators.length}</strong><span>Indikator baik (avg ≥ 4)</span></div><div><strong>${p.coachingIndicators.length}</strong><span>Indikator coaching (avg ≤ 3)</span></div><div><strong>${p.sopAssessed}/${p.sopTotal}</strong><span>SOP memiliki penilaian</span></div><div><strong>${p.criticalRatings}</strong><span>Nilai kritis (1–2)</span></div></div>
    <div class="performance-summary-grid"><section class="performance-summary-section"><h3>Strength · SOP dengan performa terbaik</h3>${showSopList(best,'Belum ada SOP dengan rata-rata nilai 4 atau lebih pada filter ini.')}</section><section class="performance-summary-section"><h3>Coaching priority · SOP yang perlu perhatian</h3>${showSopList(priority,'Tidak ada SOP dengan rata-rata di bawah 4 pada filter ini.')}</section></div>
    <section class="performance-trend-section"><h3>Tren 8 sesi audit terakhir</h3>${trendHtml}</section>
    <div class="performance-section-head"><div><div class="section-kicker">SOP & INDICATOR BREAKDOWN</div><h3>Analisis seluruh ${p.sopTotal} SOP dan ${p.totalIndicators} indikator</h3><p class="row-sub">Buka setiap SOP untuk melihat indikator yang bagus, bermasalah, belum dinilai, dan riwayat audit beserta evidence.</p></div></div>
    <div class="performance-sop-list">${sopHtml||'<div class="empty">Master SOP belum tersedia.</div>'}</div>`;
  host.querySelectorAll('[data-performance-audit]').forEach(button=>button.addEventListener('click',()=>{
    const audit=p.audits.find(a=>String(a.id)===String(button.dataset.performanceAudit));
    if(audit)showAuditDetail(audit);
  }));
}
function openCrewPerformance(name){
  selectedPerformanceCrew=name;
  renderCrewPerformanceDetail(name);
  $('crewPerformanceDetail')?.scrollIntoView({behavior:'smooth',block:'start'});
}
// ================= END CREW PERFORMANCE =================

function renderAll(){
  renderDashboard();
  renderSopControl();
  renderAuditHistory();
  renderCoaching();
  renderMasterData();
  renderCrewPerformance();

  if(onlineMode && db){
    let btn = document.getElementById('appLogoutBtn');

    if(!btn){
      btn = document.createElement('button');
      btn.id = 'appLogoutBtn';
      btn.textContent = 'Logout';
      btn.style.cssText =
      'position:static;display:inline-flex;align-items:center;' +
      'padding:8px 12px;background:#111827;color:#fff;' +
      'border:0;border-radius:8px;font-weight:700;cursor:pointer;';

      btn.addEventListener('click', async ()=>{
        btn.disabled = true;
        btn.textContent = 'Keluar...';

        const {error} = await db.auth.signOut();

        if(error){
          btn.disabled = false;
          btn.textContent = 'Logout';
          showToast('Logout gagal: ' + error.message);
          return;
        }

        onlineMode = false;
        btn.remove();
        showLoginScreen();
      });

     document.getElementById('logoutSlot').appendChild(btn);
    }
  }
}
function switchTab(tab){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id==='tab-'+tab));
  const titles={audit:['Audit Lapangan','Input cepat, dependent dropdown, dan auto-diagnosis.'],dashboard:['Dashboard','Operational control center untuk outlet, SOP, risk, dan coaching.'],sop:['SOP Control','Pantau kesiapan 32 SOP dan buka detail indikator.'],coaching:['Coaching','Kelola action, PIC, due date, dan SLA follow-up.'],performance:['Crew Performance','Analisis performa individu berdasarkan histori 32 SOP dan seluruh indikator.'],master:['Master Data','Kelola outlet, data crew, status, dan perpindahan penempatan.']};
  $('pageTitle').textContent=titles[tab][0]; $('pageSubtitle').textContent=titles[tab][1];
  if(tab==='sop') renderSopControl();
  if(tab==='dashboard') renderDashboard();
  if(tab==='master') renderMasterData();
  if(tab==='performance') renderCrewPerformance();
}

document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
document.querySelectorAll('.master-view-btn').forEach(b=>b.addEventListener('click',()=>setMasterView(b.dataset.masterView)));

$('outletMasterForm').addEventListener('submit', async e=>{
  e.preventDefault();
  if(!onlineMode || !db){ showToast('Login dan koneksi Supabase diperlukan untuk mengubah outlet.'); return; }
  const originalName = $('masterOutletOriginalName').value;
  const name = $('masterOutletName').value.trim();
  if(!name){ showToast('Nama outlet wajib diisi.'); return; }
  const rawLat = $('masterOutletLatitude').value.trim();
  const rawLng = $('masterOutletLongitude').value.trim();
  const record = {
    address:$('masterOutletAddress').value.trim() || null,
    photo_path:$('masterOutletPhoto').value.trim() || null,
    latitude:rawLat === '' ? null : Number(rawLat),
    longitude:rawLng === '' ? null : Number(rawLng),
    notes:$('masterOutletNotes').value.trim() || null
  };
  if((rawLat!=='' && !Number.isFinite(record.latitude)) || (rawLng!=='' && !Number.isFinite(record.longitude))){ showToast('Latitude dan longitude harus berupa angka.'); return; }
  try{
    const {data,error} = await db.rpc('save_outlet_master', {
      p_original_name: originalName || null,
      p_name: name,
      p_address: record.address,
      p_photo_path: record.photo_path,
      p_latitude: record.latitude,
      p_longitude: record.longitude,
      p_notes: record.notes
    });
    if(error) throw error;
    if(data && data.success === false) throw new Error(data.message || data.error || 'Database menolak perubahan outlet.');
    resetOutletMasterForm();
    await refreshMasterData();
    showToast(originalName ? 'Data outlet diperbarui.' : 'Outlet baru berhasil ditambahkan.');
  }catch(err){ showToast('Gagal menyimpan outlet: ' + (err?.message || 'error')); }
});
$('outletCancelBtn').addEventListener('click',resetOutletMasterForm);
$('masterOutletSearch').addEventListener('input',renderMasterOutlets);
$('masterOutletList').addEventListener('click', async e=>{
  const edit = e.target.closest('[data-outlet-edit]');
  if(edit){ startOutletEdit(edit.dataset.outletEdit); return; }
  const toggle = e.target.closest('[data-outlet-toggle]');
  if(!toggle) return;
  const outlet = state.outlets.find(o=>String(o.name)===String(toggle.dataset.outletToggle));
  if(!outlet) return;
  const nextStatus = isActiveOutlet(outlet) ? 'INACTIVE' : 'ACTIVE';
  const verb = nextStatus === 'INACTIVE' ? 'menonaktifkan' : 'mengaktifkan';
  if(!confirm(`Yakin ${verb} outlet ${outlet.name}? Riwayat audit tidak akan dihapus.`)) return;
  if(!db || !onlineMode){ showToast('Login dan koneksi Supabase diperlukan.'); return; }
  try{
    const {data,error} = await db.rpc('set_outlet_master_status', {p_name:outlet.name,p_status:nextStatus});
    if(error) throw error;
    if(data && data.success === false) throw new Error(data.message || data.error || 'Database menolak perubahan status outlet.');
    await refreshMasterData();
    showToast(`Outlet ${outlet.name} sekarang ${nextStatus}.`);
  }catch(err){ showToast('Gagal mengubah status outlet: '+(err?.message||'error')); }
});
$('masterRefreshBtn').addEventListener('click',async()=>{
  try{ await refreshMasterData(); showToast('Master Data diperbarui.'); }
  catch(err){ showToast('Gagal refresh Master Data: '+(err?.message||'error')); }
});
$('masterCrewId').addEventListener('focus',()=>{ if(!$('masterCrewId').value) $('masterCrewId').value=nextCrewId(); });
$('masterCrewForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const crewId=$('masterCrewId').value.trim().toUpperCase();
  const name=$('masterCrewName').value.trim();
  const outlet=$('masterCrewOutlet').value;
  const position=$('masterCrewPosition').value;
  const startDate=$('masterCrewStartDate').value || today();
  const notes=$('masterCrewNotes').value.trim() || null;
  if(!crewId || !name || !outlet || !position){ showToast('Lengkapi ID, nama, outlet, dan jabatan crew.'); return; }
  try{
    await runCrewRpc('add_crew',{p_crew_id:crewId,p_name:name,p_outlet:outlet,p_position:position,p_start_date:startDate,p_notes:notes},'Crew berhasil ditambahkan.');
    $('masterCrewForm').reset();
    $('masterCrewId').value=nextCrewId();
    $('masterCrewStartDate').value=today();
  }catch(err){ showToast('Gagal menambah crew: '+(err?.message||'error')); }
});
$('masterCrewSearch').addEventListener('input',renderMasterCrews);
$('masterCrewStatusFilter').addEventListener('change',renderMasterCrews);
$('masterCrewList').addEventListener('click',async e=>{
  const edit=e.target.closest('[data-crew-edit]');
  if(edit){startCrewEdit(edit.dataset.crewEdit);return;}
  const roll=e.target.closest('[data-crew-roll]');
  if(roll){
    $('crewMoveCrew').value=roll.dataset.crewRoll;
    syncCrewMoveMinimumDate();
    const crew=crewMasterRows().find(c=>String(c.crew_id)===String(roll.dataset.crewRoll));
    if(crew?.outlet && [...$('crewMoveOutlet').options].some(o=>o.value===crew.outlet)) $('crewMoveOutlet').value=crew.outlet;
    if(crew?.position && [...$('crewMovePosition').options].some(o=>o.value===crew.position)) $('crewMovePosition').value=crew.position;
    $('crewMoveForm').scrollIntoView({behavior:'smooth',block:'start'});return;
  }
  const reactivate=e.target.closest('[data-crew-reactivate]');
  if(reactivate){
    $('crewReactivateCrew').value=reactivate.dataset.crewReactivate;
    $('crewReactivateForm').scrollIntoView({behavior:'smooth',block:'start'});
    showToast('Pilih outlet dan jabatan, lalu tekan Aktifkan Crew.');return;
  }
  const deactivate=e.target.closest('[data-crew-deactivate]');
  if(!deactivate)return;
  const crewId=deactivate.dataset.crewDeactivate;
  const crew=crewMasterRows().find(c=>String(c.crew_id)===String(crewId));
  if(!confirm(`Nonaktifkan ${crew?.name||crewId}? Penempatan aktif akan ditutup dan riwayat tetap disimpan.`))return;
  const notes=prompt('Catatan nonaktif (opsional):','') || null;
  try{await runCrewRpc('deactivate_crew',{p_crew_id:crewId,p_end_date:today(),p_notes:notes},`Crew ${crew?.name||crewId} dinonaktifkan.`);}
  catch(err){showToast('Gagal menonaktifkan crew: '+(err?.message||'error'));}
});
$('crewEditForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!db || !onlineMode){showToast('Login dan koneksi Supabase diperlukan.');return;}
  const id=$('crewEditId').value;
  const name=$('crewEditName').value.trim();
  if(!name){showToast('Nama crew wajib diisi.');return;}
  try{
    const {data,error}=await db.rpc('rename_crew_master',{p_crew_id:id,p_name:name});
    if(error)throw error;
    if(data && data.success === false)throw new Error(data.message || data.error || 'Database menolak perubahan nama crew.');
    resetCrewEditForm();
    await refreshMasterData();
    showToast('Nama crew diperbarui.');
  }catch(err){showToast('Gagal mengedit crew: '+(err?.message||'error'));}
});
$('crewEditCancel').addEventListener('click',resetCrewEditForm);
function dateAfter(isoDate){
  const match=String(isoDate||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match) return today();
  const d=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
  d.setUTCDate(d.getUTCDate()+1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function syncCrewMoveMinimumDate(){
  const input=$('crewMoveStartDate');
  if(!input) return;
  const id=$('crewMoveCrew')?.value;
  const crew=crewMasterRows().find(c=>String(c.crew_id)===String(id));
  const minimum=crew?.start_date ? dateAfter(crew.start_date) : today();
  input.min=minimum;
  if(!input.value || input.value < minimum) input.value=minimum;
}
$('crewMoveStartDate').value=today();
$('crewReactivateStartDate').value=today();
$('masterCrewStartDate').value=today();
$('crewMoveCrew').addEventListener('change',syncCrewMoveMinimumDate);
syncCrewMoveMinimumDate();
$('crewMoveForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const crewId=$('crewMoveCrew').value, outlet=$('crewMoveOutlet').value, position=$('crewMovePosition').value;
  const startDate=$('crewMoveStartDate').value || today(), notes=$('crewMoveNotes').value.trim() || null;
  if(!crewId||!outlet||!position){showToast('Pilih crew, outlet tujuan, dan jabatan.');return;}
  const crew=crewMasterRows().find(c=>String(c.crew_id)===String(crewId));
  if(crew?.start_date && startDate <= crew.start_date){
    syncCrewMoveMinimumDate();
    showToast(`Tanggal mulai perpindahan harus setelah ${crew.start_date}. Tanggal disesuaikan ke ${$('crewMoveStartDate').value}.`);
    return;
  }
  if(crew?.outlet===outlet){
    if(!confirm(`Crew ini sudah ditempatkan di ${outlet}. Lanjutkan untuk membuat penempatan baru pada outlet yang sama?`))return;
  }else if(!confirm(`Pindahkan ${crew?.name||crewId} ke ${outlet}? Riwayat penempatan lama akan tetap disimpan.`))return;
  try{
    await runCrewRpc('roll_crew',{p_crew_id:crewId,p_new_outlet:outlet,p_start_date:startDate,p_position:position,p_notes:notes},'Perpindahan crew berhasil disimpan.');
    $('crewMoveForm').reset();$('crewMoveStartDate').value=today();syncCrewMoveMinimumDate();
  }catch(err){showToast('Gagal memindahkan crew: '+(err?.message||'error'));}
});
$('crewReactivateForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const crewId=$('crewReactivateCrew').value, outlet=$('crewReactivateOutlet').value, position=$('crewReactivatePosition').value;
  const startDate=$('crewReactivateStartDate').value || today(), notes=$('crewReactivateNotes').value.trim() || null;
  if(!crewId||!outlet||!position){showToast('Pilih crew, outlet, dan jabatan untuk aktivasi.');return;}
  try{
    const crew=crewMasterRows().find(c=>String(c.crew_id)===String(crewId));
    await runCrewRpc('reactivate_crew',{p_crew_id:crewId,p_outlet:outlet,p_start_date:startDate,p_position:position,p_notes:notes},`Crew ${crew?.name||crewId} berhasil diaktifkan.`);
    $('crewReactivateForm').reset();$('crewReactivateStartDate').value=today();
  }catch(err){showToast('Gagal mengaktifkan crew: '+(err?.message||'error'));}
});
$('crewPerformanceSearch')?.addEventListener('input',renderCrewPerformance);
$('crewPerformancePeriod')?.addEventListener('change',renderCrewPerformance);
$('crewPerformanceOutlet')?.addEventListener('change',renderCrewPerformance);
$('crewPerformanceList')?.addEventListener('click',e=>{const button=e.target.closest('[data-performance-open]');if(button)openCrewPerformance(button.dataset.performanceOpen);});
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

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();window.__deferredInstall=e;$('installBtn').hidden=false;});
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
window.addEventListener('online',async()=>{if(!onlineMode && cfg.SUPABASE_URL){const ok=await initDB();if(ok)await syncPending();renderAll();}});

(async function boot(){
  showLoginScreen();

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
