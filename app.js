"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const STORAGE = "apl-gym-manager-trainees-v1", LICENSE = "apl-gym-manager-license-v1", DEVICE = "apl-gym-manager-device-v1", PC_LINK = "apl-gym-manager-pc-link-v1";
  const app = { trainees: [], filter: "all", deferredInstall: null, stream: null, scanTimer: null, nfcAbort: null, lastNfcToken: "", lastNfcAt: 0, pairStream: null, pairTimer: null, pcLink: null, pcRevision: "", pcBaseSnapshot: [], pcPending: null, pcSaving: false, pcDirty: false, pcTimer: null, pcOfflineNotified: false };
  const dayKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  const today = () => dayKey(new Date());
  const deviceId = localStorage.getItem(DEVICE) || (() => { const bytes=crypto.getRandomValues(new Uint8Array(32)); const id=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("").toUpperCase(); localStorage.setItem(DEVICE,id); return id; })();

  function setMessage(node, text, error=false) { node.textContent=text||""; node.classList.toggle("error",error); }
  function cleanDate(value) { const text=String(value||""); const iso=text.match(/^(\d{4})-(\d{2})-(\d{2})/); if(iso)return `${iso[1]}-${iso[2]}-${iso[3]}`; const d=text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/); return d?`${d[3]}-${String(d[2]).padStart(2,"0")}-${String(d[1]).padStart(2,"0")}`:""; }
  function showLicense(message="",error=false) { $("licenseScreen").hidden=false; $("appView").hidden=true; $("deviceId").textContent=deviceId; setMessage($("licenseMessage"),message,error); }
  function fromBase64url(text) { const b64=text.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(text.length/4)*4,"="); const raw=atob(b64); return Uint8Array.from(raw,c=>c.charCodeAt(0)); }
  async function loadKeys() {
    const names=["public-key.pem","online-public-key.pem"], keys=[];
    for(const name of names) {
      try {
        const response=await fetch(`/manager/${name}`,{cache:"no-store"}); if(!response.ok)continue;
        const pem=await response.text(), encoded=pem.replace(/-----[^-]+-----|\s/g,"");
        const der=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));
        keys.push(await crypto.subtle.importKey("spki",der,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]));
      } catch(_) {}
    }
    return keys;
  }
  async function verifyLicense(code) {
    try {
      const parts=String(code||"").trim().split("."); if(parts.length!==2)return {valid:false,reason:"كود الترخيص غير صحيح"};
      const payloadBytes=fromBase64url(parts[0]), data=JSON.parse(new TextDecoder().decode(payloadBytes)), signature=fromBase64url(parts[1]);
      const keys=await loadKeys(); let valid=false;
      for(const key of keys) { try { if(await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,signature,payloadBytes)){valid=true;break;} } catch(_) {} }
      if(!valid)return {valid:false,reason:"كود الترخيص غير صالح"};
      if((data.type||"activation")!=="activation"||data.product!=="GymManager")return {valid:false,reason:"هذا الكود ليس ترخيص APL GYM"};
      if(String(data.machineId||"").toUpperCase()!==deviceId)return {valid:false,reason:"هذا الترخيص مخصص لهاتف آخر"};
      if(data.expires&&Date.parse(data.expires)<=Date.now())return {valid:false,reason:"انتهت صلاحية الترخيص"};
      return {valid:true,data};
    } catch(_) { return {valid:false,reason:"تعذر التحقق من توقيع الترخيص"}; }
  }
  async function checkLicense() {
    const code=localStorage.getItem(LICENSE); if(!code)return showLicense();
    const result=await verifyLicense(code); if(!result.valid){localStorage.removeItem(LICENSE);showLicense(result.reason,true);return;}
    $("licenseScreen").hidden=true; $("appView").hidden=false; render();
  }
  async function activate(online) {
    const code=$("licenseCode").value.trim(); if(!code)return setMessage($("licenseMessage"),"أدخل كود الترخيص أولًا",true);
    const button=online?$("activateOnline"):$("activateOffline");button.disabled=true;setMessage($("licenseMessage"),online?"جارٍ الاتصال بخادم التفعيل…":"جارٍ التحقق من الكود…");
    try {
      let signed=code;
      if(online){const response=await fetch("/v1/activate",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",body:JSON.stringify({licenseKey:code,machineId:deviceId,product:"GymManager"})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.reason||"تعذر تفعيل الترخيص عبر الإنترنت");signed=body.licenseCode||"";}
      const verified=await verifyLicense(signed);if(!verified.valid)throw new Error(verified.reason);
      localStorage.setItem(LICENSE,signed);setMessage($("licenseMessage"),"تم تفعيل APL GYM بنجاح");await new Promise(resolve=>setTimeout(resolve,350));await checkLicense();
    } catch(error) { setMessage($("licenseMessage"),error.message||"تعذر التفعيل",true); }
    finally { button.disabled=false; }
  }
  function copyRecords(value) { return JSON.parse(JSON.stringify(Array.isArray(value)?value:[])); }
  function loadLocalData() { try { const value=JSON.parse(localStorage.getItem(STORAGE)||"[]");app.trainees=Array.isArray(value)?value.filter(x=>x&&typeof x==="object"):[]; } catch(_) { app.trainees=[]; } }
  function getPcLink() { try { const value=JSON.parse(localStorage.getItem(PC_LINK)||"null");return value&&value.type==="APL_GYM_LOCAL_SYNC"&&Array.isArray(value.endpoints)&&/^[a-f0-9]{64}$/i.test(value.token||"")?value:null; } catch(_) { return null; } }
  async function pcRequest(endpoint, options={}) {
    let lastError;
    for (const base of app.pcLink?.endpoints || []) {
      try {
        const response=await fetch(`${base}/v1/local-sync/data`,{cache:"no-store",mode:"cors",...(base.startsWith("http://")?{targetAddressSpace:"local"}:{}),...options,headers:{...(options.headers||{}),Authorization:`Bearer ${app.pcLink.token}`}});
        const body=await response.json().catch(()=>({}));
        if(!response.ok) { const error=new Error(body.reason||"تعذر الاتصال بكمبيوتر القاعة");error.status=response.status;error.body=body;throw error; }
        return body;
      } catch(error) { lastError=error; if(error.status)throw error; }
    }
    throw lastError||new Error("لا يوجد عنوان كمبيوتر مرتبط");
  }
  function pcOfflineMessage(error){return error?.status===503||error?.body?.computerOffline?"جهاز القاعة مغلق أو غير متصل بالإنترنت. سنعيد الاتصال تلقائيًا عند عودته.":"تعذر الوصول إلى جهاز القاعة. تأكد من اتصال الإنترنت؛ ستتم إعادة المحاولة تلقائيًا.";}
  function recordEqual(a,b) { return JSON.stringify(a??null)===JSON.stringify(b??null); }
  function mergePcSnapshots(baseList, localList, remoteList) {
    const base=new Map(baseList.map(item=>[String(item.id),item])),local=new Map(localList.map(item=>[String(item.id),item])),remote=new Map(remoteList.map(item=>[String(item.id),item]));
    const merged=[];
    for(const id of new Set([...base.keys(),...local.keys(),...remote.keys()])) {
      const old=base.get(id),mine=local.get(id),theirs=remote.get(id),mineChanged=!recordEqual(mine,old),theirsChanged=!recordEqual(theirs,old);
      if(!mineChanged){if(theirs)merged.push(theirs);continue;}
      if(!theirsChanged){if(mine)merged.push(mine);continue;}
      if(!mine){if(theirs)merged.push(theirs);continue;}
      if(!theirs){merged.push(mine);continue;}
      const mineTime=Date.parse(mine.updatedAt||"")||0,theirTime=Date.parse(theirs.updatedAt||"")||0,winner=mineTime>theirTime?mine:theirs,other=winner===mine?theirs:mine;
      const combined={...other,...winner};
      for(const field of ["attendance","history"]) if(Array.isArray(mine[field])||Array.isArray(theirs[field])) combined[field]=[...new Set([...(mine[field]||[]),...(theirs[field]||[])])];
      merged.push(combined);
    }
    return merged;
  }
  async function readPcData() {
    const result=await pcRequest();
    app.pcRevision=String(result.revision||"");app.pcBaseSnapshot=copyRecords(result.trainees);app.trainees=copyRecords(result.trainees);app.pcDirty=false;render();
    setMessage($("pcLinkMessage"),"الهاتف متصل بالكمبيوتر. البيانات تُقرأ وتُحفظ على الكمبيوتر.");updatePcLinkControls();
  }
  async function loadData() {
    app.pcLink=getPcLink();
    if(!app.pcLink){loadLocalData();render();updatePcLinkControls();return;}
    app.trainees=[];setMessage($("pcLinkMessage"),"جارٍ الاتصال بكمبيوتر القاعة…");
    try{await readPcData();}catch(error){setMessage($("pcLinkMessage"),error.status===503||error.body?.computerOffline?pcOfflineMessage(error):`${error.message}. ستتم إعادة المحاولة تلقائيًا عند توفر الكمبيوتر.`,true);updatePcLinkControls();}
  }
  async function pushPcSnapshot(snapshot) {
    let candidate=copyRecords(snapshot);
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const result=await pcRequest("",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:app.pcRevision,trainees:candidate})});
        app.pcRevision=String(result.revision||"");app.pcBaseSnapshot=copyRecords(candidate);app.pcDirty=false;
        if(recordEqual(app.trainees,candidate))app.trainees=copyRecords(candidate);
        setMessage($("pcLinkMessage"),"تم حفظ التغييرات على الكمبيوتر.");
        return;
      } catch(error) {
        if(error.status!==409||!Array.isArray(error.body?.trainees))throw error;
        app.pcRevision=String(error.body.revision||"");
        candidate=mergePcSnapshots(app.pcBaseSnapshot,app.trainees,error.body.trainees);
        app.pcBaseSnapshot=copyRecords(error.body.trainees);app.trainees=copyRecords(candidate);render();
      }
    }
    throw new Error("تغيّرت البيانات عدة مرات على الكمبيوتر؛ أعد المحاولة بعد تحديث الصفحة.");
  }
  async function flushPcQueue() {
    if(app.pcSaving||!app.pcLink)return;
    app.pcSaving=true;
    try {
      while(app.pcPending) { const snapshot=app.pcPending;app.pcPending=null;await pushPcSnapshot(snapshot); }
    } catch(error) {
      app.pcDirty=true;app.pcPending=copyRecords(app.trainees);setMessage($("pcLinkMessage"),`تعذر الحفظ على الكمبيوتر: ${error.message}`,true);
    } finally { app.pcSaving=false; }
  }
  function saveData() {
    if(!app.pcLink){localStorage.setItem(STORAGE,JSON.stringify(app.trainees));return;}
    const base=new Map(app.pcBaseSnapshot.map(item=>[String(item.id),item]));
    app.trainees.forEach(item=>{const previous=base.get(String(item.id));if(!previous||!recordEqual(item,previous))item.updatedAt=new Date().toISOString();});
    app.pcDirty=true;app.pcPending=copyRecords(app.trainees);flushPcQueue();
  }
  function updatePcLinkControls(){
    const linked=!!app.pcLink;
    if($("disconnectPc"))$("disconnectPc").hidden=!linked;
    if($("scanPcPairing"))$("scanPcPairing").textContent=linked?"تغيير الكمبيوتر المرتبط (مسح QR جديد)":"مسح QR الكمبيوتر للربط";
  }
  function stopPairCamera(){if(app.pairTimer)clearTimeout(app.pairTimer);app.pairTimer=null;if(app.pairStream){app.pairStream.getTracks().forEach(track=>track.stop());app.pairStream=null;}const video=$("pairCamera");if(video){video.pause();video.srcObject=null;video.hidden=true;}}
  function validPairing(value){
    if(!value||value.type!=="APL_GYM_LOCAL_SYNC"||!/^[a-f0-9]{64}$/i.test(value.token||"")||!Array.isArray(value.endpoints))return null;
    const endpoints=value.endpoints.filter(raw=>{try{const url=new URL(raw);const parts=url.hostname.split(".").map(Number);const privateIp=url.protocol==="http:"&&!url.username&&!url.password&&url.port&&parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(parts[0]===10||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168));const stableRelay=url.protocol==="https:"&&["apl-gym-license.apleng.workers.dev","apl-gym-license.iyaddahmoune771.workers.dev"].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname==="/"&&!url.search&&!url.hash;return Boolean(privateIp||stableRelay);}catch(_){return false;}});
    return endpoints.length?{type:value.type,endpoints,token:value.token}:null;
  }
  async function connectToComputer(payload){
    const link=validPairing(payload);if(!link)throw new Error("رمز QR غير صالح");
    const previous=app.pcLink;app.pcLink=link;
    try{
      const result=await pcRequest();
      localStorage.setItem(PC_LINK,JSON.stringify(link));
      app.pcRevision=String(result.revision||"");app.pcBaseSnapshot=copyRecords(result.trainees);app.trainees=copyRecords(result.trainees);app.pcDirty=false;app.pcPending=null;
      stopPairCamera();render();updatePcLinkControls();setMessage($("pcLinkMessage"),"تم ربط الهاتف بالكمبيوتر. أصبحت بيانات الكمبيوتر ظاهرة هنا.");
    }catch(error){app.pcLink=previous;throw error;}
  }
  function validLocalAddress(value){
    try{
      const url=new URL(/^https?:\/\//i.test(value)?value:`http://${value}`);
      const stableRelay=url.protocol==="https:"&&["apl-gym-license.apleng.workers.dev","apl-gym-license.iyaddahmoune771.workers.dev"].includes(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname==="/"&&!url.search&&!url.hash;
      if(stableRelay)return url.origin;
      const octets=url.hostname.split(".").map(Number);
      const privateIp=octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(octets[0]===10||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168));
      if(url.protocol!=="http:"||!privateIp||url.username||url.password||url.pathname!=="/"||url.search||url.hash||Number(url.port)!==42851)throw new Error();
      return url.origin;
    }catch(_){throw new Error("أدخل عنوان Cloudflare الثابت أو عنوان الكمبيوتر المحلي الظاهر في إعداداته.");}
  }
  async function connectUsingCode(){
    const button=$("connectPcCode"),code=$("pcPairCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(!/^[A-F0-9]{14}$/.test(code)){setMessage($("pcLinkMessage"),"أدخل رمز الربط المكوّن من 14 خانة كما يظهر على الكمبيوتر.",true);return;}
    let base;try{base=validLocalAddress($("pcAddress").value.trim());}catch(error){setMessage($("pcLinkMessage"),error.message,true);return;}
    button.disabled=true;setMessage($("pcLinkMessage"),"جارٍ التحقق من رمز الربط…");
    try{
      const response=await fetch(`${base}/v1/local-sync/pair`,{method:"POST",mode:"cors",...(base.startsWith("http://")?{targetAddressSpace:"local"}:{}),cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});
      const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.reason||"تعذر الربط");
      await connectToComputer({type:result.type,endpoints:[base],token:result.token});$("pcPairCode").value="";
    }catch(error){setMessage($("pcLinkMessage"),error.message||"تعذر الاتصال. تحقق من العنوان والشبكة والرمز.",true);}
    finally{button.disabled=false;}
  }
  async function startPairCamera(){
    if(!("BarcodeDetector" in window)||!navigator.mediaDevices?.getUserMedia){setMessage($("pcLinkMessage"),"مسح QR غير مدعوم في هذا المتصفح. افتح التطبيق في Chrome على Android.",true);return;}
    stopPairCamera();
    try{
      app.pairStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
      const video=$("pairCamera");video.srcObject=app.pairStream;video.hidden=false;await video.play();
      const detector=new BarcodeDetector({formats:["qr_code"]});
      const loop=async()=>{
        if(!app.pairStream)return;
        try{
          const codes=await detector.detect(video);
          if(codes.length){let payload;try{payload=JSON.parse(codes[0].rawValue);}catch(_){throw new Error("QR لا يحتوي بيانات ربط APL GYM");}await connectToComputer(payload);return;}
        }catch(error){if(error.message&&error.message!=="No QR code found"){stopPairCamera();setMessage($("pcLinkMessage"),error.message||"تعذر قراءة رمز الربط",true);return;}}
        app.pairTimer=setTimeout(loop,300);
      };
      setMessage($("pcLinkMessage"),"وجّه كاميرا الهاتف إلى QR الظاهر في إعدادات الكمبيوتر.");loop();
    }catch(error){stopPairCamera();setMessage($("pcLinkMessage"),error?.name==="NotAllowedError"?"اسمح باستخدام الكاميرا لمسح QR الكمبيوتر.":"تعذر فتح الكاميرا لمسح QR.",true);}
  }
  async function pollComputer(){
    if(!app.pcLink)return;
    if(app.pcDirty){flushPcQueue();return;}
    try{
      const result=await pcRequest();
      app.pcOfflineNotified=false;
      if(String(result.revision||"")===app.pcRevision)return;
      app.pcRevision=String(result.revision||"");app.pcBaseSnapshot=copyRecords(result.trainees);app.trainees=copyRecords(result.trainees);render();
      setMessage($("pcLinkMessage"),"تم تحديث البيانات من الكمبيوتر.");
    }catch(error){if(!app.pcOfflineNotified){setMessage($("pcLinkMessage"),pcOfflineMessage(error),true);app.pcOfflineNotified=true;}}
  }
  function isMonthly(t) { return String(t.subscriptionType||"").toLowerCase()==="monthly"; }
  function remaining(t) { return Math.max(0,Number(t.sessionsRemaining)||0); }
  function expired(t) { const end=cleanDate(t.end);return Boolean(end&&end<today())||(!isMonthly(t)&&remaining(t)<=0); }
  function status(t) { return expired(t)?"expired":String(t.payment).toLowerCase()==="unpaid"?"unpaid":"active"; }
  function statusText(t) { return status(t)==="expired"?"منتهي":status(t)==="unpaid"?"غير مدفوع":"نشط"; }
  function formatDate(value) { const d=cleanDate(value);if(!d)return "—";const [y,m,day]=d.split("-").map(Number);return new Intl.DateTimeFormat("ar-DZ",{day:"numeric",month:"short"}).format(new Date(y,m-1,day)); }
  function makeCard(t) {
    const card=document.createElement("article");card.className="member-card";card.tabIndex=0;
    const avatar=document.createElement("span");avatar.className="avatar";avatar.textContent=String(t.name||"؟").trim().charAt(0)||"؟";
    const main=document.createElement("div");main.className="member-main";const name=document.createElement("b");name.textContent=t.name||"متدرب";const details=document.createElement("small");details.textContent=`${t.memberId||"بدون رقم"}${t.phone?` · ${t.phone}`:""}`;main.append(name,details);
    const meta=document.createElement("div");meta.className="member-meta";const badge=document.createElement("span");badge.className=`status ${status(t)}`;badge.textContent=statusText(t);const count=document.createElement("strong");count.textContent=isMonthly(t)?`إلى ${formatDate(t.end)}`:`${remaining(t)} / ${Number(t.sessionsTotal)||0} حصة`;meta.append(badge,count);card.append(avatar,main,meta);
    card.addEventListener("click",()=>openMember(t));card.addEventListener("keydown",e=>{if(e.key==="Enter")openMember(t);});return card;
  }
  function setList(host,items) { host.replaceChildren();if(!items.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="لا توجد بيانات لعرضها بعد";host.append(empty);return;}items.forEach(t=>host.append(makeCard(t))); }
  function render() {
    $("totalCount").textContent=String(app.trainees.length);$("activeCount").textContent=`${app.trainees.filter(t=>status(t)==="active").length} نشط`;
    $("expiredCount").textContent=`${app.trainees.filter(t=>status(t)==="expired").length} منتهي`;
    $("paidCount").textContent=String(app.trainees.filter(t=>String(t.payment).toLowerCase()!=="unpaid"&&status(t)==="active").length);
    $("unpaidCount").textContent=String(app.trainees.filter(t=>String(t.payment).toLowerCase()==="unpaid").length);
    const ordered=app.trainees.slice().sort((a,b)=>String(b.updatedAt||b.start||"").localeCompare(String(a.updatedAt||a.start||"")));
    setList($("recentList"),ordered.slice(0,5));
    const term=$("search").value.trim().toLowerCase();const list=ordered.filter(t=>{const matches=`${t.name||""} ${t.phone||""} ${t.memberId||""} ${t.barcode||""}`.toLowerCase().includes(term);return matches&&(app.filter==="all"||status(t)===app.filter);});setList($("traineeList"),list);
    const todayItems=[];for(const t of app.trainees)for(const item of (Array.isArray(t.attendance)?t.attendance:[])){const stamp=String(item);if(cleanDate(stamp.slice(0,10))===today())todayItems.push({t,stamp});}
    todayItems.sort((a,b)=>b.stamp.localeCompare(a.stamp));$("todayAttendanceCount").textContent=String(todayItems.length);setList($("todayList"),todayItems.map(x=>({...x.t,memberId:`${x.t.memberId||""} · ${new Date(x.stamp).toLocaleTimeString("ar-DZ",{hour:"2-digit",minute:"2-digit"})}`})));
  }
  function showPage(id) { stopCamera();stopNfc();if(id!=="settingsPage")stopPairCamera();document.querySelectorAll(".page").forEach(p=>p.hidden=p.id!==id);document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===id));const title={homePage:"الرئيسية",traineesPage:"المتدربون",attendancePage:"الحضور",settingsPage:"الإعدادات"};$("pageTitle").textContent=title[id]||"الرئيسية"; }
  function addMonths(dateText,months) { const [y,m,d]=dateText.split("-").map(Number);const out=new Date(y,m-1,d);out.setMonth(out.getMonth()+months);if(out.getDate()<d)out.setDate(0);return dayKey(out); }
  function blankForm() { $("memberForm").reset();$("memberId").value="";$("memberNumber").value=String(Date.now()).slice(-8);$("startDate").value=today();$("endDate").value=addMonths(today(),1);$("sessionsTotal").value="12";$("sessionsRemaining").value="12";$("months").value="1";$("dialogTitle").textContent="إضافة متدرب";$("renewMember").hidden=true;$("deleteMember").hidden=true;$("formMessage").textContent="";updateTypeFields(); }
  function openMember(t=null) { blankForm();if(t){$("memberId").value=t.id;$("memberName").value=t.name||"";$("memberPhone").value=t.phone||"";$("memberNumber").value=t.memberId||"";$("memberBarcode").value=t.barcode||"";$("subscriptionType").value=isMonthly(t)?"monthly":"sessions";$("sessionsTotal").value=Number(t.sessionsTotal)||12;$("sessionsRemaining").value=remaining(t);$("startDate").value=cleanDate(t.start)||today();$("endDate").value=cleanDate(t.end)||"";$("payment").value=t.payment||"paid";$("dialogTitle").textContent="تعديل بيانات المتدرب";$("renewMember").hidden=false;$("deleteMember").hidden=false;updateTypeFields();}$("memberDialog").showModal(); }
  function updateTypeFields(){const monthly=$("subscriptionType").value==="monthly";$("sessionFields").hidden=monthly;$("monthlyFields").hidden=!monthly;document.querySelector('#memberBarcode').closest('label').hidden=monthly;}
  function saveMember(event) { event.preventDefault();const id=$("memberId").value||`${Date.now()}-${crypto.randomUUID().slice(0,8)}`;const previous=app.trainees.find(t=>String(t.id)===id);const monthly=$("subscriptionType").value==="monthly";const start=$("startDate").value||today();let end=$("endDate").value;if(monthly&&!previous)end=addMonths(start,Math.max(1,Number($("months").value)||1));if(!end)end=addMonths(start,2);const item={...(previous||{}),id,name:$("memberName").value.trim(),phone:$("memberPhone").value.trim(),memberId:$("memberNumber").value.trim()||String(Date.now()).slice(-8),barcode:monthly?"":$("memberBarcode").value.trim(),subscriptionType:monthly?"monthly":"sessions",sessionsTotal:monthly?0:Math.max(1,Number($("sessionsTotal").value)||1),sessionsRemaining:monthly?0:Math.max(0,Math.min(Number($("sessionsTotal").value)||1,Number($("sessionsRemaining").value)||0)),start,end,payment:$("payment").value,attendance:Array.isArray(previous?.attendance)?previous.attendance:[],history:Array.isArray(previous?.history)?previous.history:[],updatedAt:new Date().toISOString()};if(previous)app.trainees[app.trainees.indexOf(previous)]=item;else app.trainees.unshift(item);saveData();render();$("memberDialog").close(); }
  function renewMember() { const id=$("memberId").value;const t=app.trainees.find(x=>String(x.id)===id);if(!t)return;const start=$("startDate").value||today();const monthly=$("subscriptionType").value==="monthly";t.subscriptionType=monthly?"monthly":"sessions";t.start=start;t.end=monthly?addMonths(start,Math.max(1,Number($("months").value)||1)):($("endDate").value||addMonths(start,2));t.sessionsTotal=monthly?0:Math.max(1,Number($("sessionsTotal").value)||1);t.sessionsRemaining=monthly?0:t.sessionsTotal;t.barcode=monthly?"":($("memberBarcode").value.trim()||t.barcode||"");t.payment=$("payment").value;t.updatedAt=new Date().toISOString();t.history=Array.isArray(t.history)?t.history:[];t.history.push({type:"renewal",start:t.start,end:t.end,date:t.updatedAt,sessionsTotal:t.sessionsTotal});saveData();render();$("memberDialog").close(); }
  function scan(code) { const t=app.trainees.find(x=>String(x.barcode||"").trim()===String(code||"").trim()||String(x.memberId||"").trim()===String(code||"").trim());if(!t){setMessage($("scanMessage"),"لم نعثر على متدرب بهذا الباركود",true);return;}if(expired(t)){setMessage($("scanMessage"),`اشتراك ${t.name} منتهٍ؛ لم يُسجّل الحضور`,true);return;}if(!isMonthly(t)){if(remaining(t)<=0){setMessage($("scanMessage"),`انتهت حصص ${t.name}`,true);return;}t.sessionsRemaining=remaining(t)-1;}t.attendance=Array.isArray(t.attendance)?t.attendance:[];t.attendance.push(new Date().toISOString());t.updatedAt=new Date().toISOString();saveData();render();setMessage($("scanMessage"),`تم تسجيل حضور ${t.name}${isMonthly(t)?"":" · تبقّى "+t.sessionsRemaining+" حصة"}`);$("barcodeInput").value=""; }
  async function startCamera() { if(!("BarcodeDetector" in window)||!navigator.mediaDevices?.getUserMedia){setMessage($("scanMessage"),"المسح بالكاميرا غير مدعوم هنا؛ أدخل رقم الباركود يدويًا",true);return;}try{app.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});const video=$("camera");video.srcObject=app.stream;video.hidden=false;await video.play();const detector=new BarcodeDetector({formats:["code_128","code_39","ean_13","ean_8","qr_code"]});const loop=async()=>{if(!app.stream)return;try{const codes=await detector.detect(video);if(codes.length){scan(codes[0].rawValue);stopCamera();return;}}catch(_){}app.scanTimer=setTimeout(loop,250);};loop();setMessage($("scanMessage"),"وجّه الكاميرا إلى باركود المتدرب.");}catch(_){setMessage($("scanMessage"),"تعذر فتح الكاميرا. تحقق من إذن المتصفح أو أدخل الرقم يدويًا.",true);} }
  function nfcToken(message) {
    for (const record of message?.records || []) {
      try {
        if (record.recordType === "text") {
          const bytes = new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength);
          const languageLength = bytes.length ? bytes[0] & 0x3f : 0;
          const value = new TextDecoder(record.encoding || "utf-8").decode(bytes.subarray(Math.min(1 + languageLength, bytes.length))).trim();
          if (value) return value.replace(/^APL-GYM:/i, "").trim();
        }
        if (record.recordType === "url" || record.recordType === "absolute-url") {
          const value = record.recordType === "url" ? record.data : new TextDecoder().decode(record.data);
          const url = new URL(value);
          const member = url.searchParams.get("member") || url.searchParams.get("id");
          if (member) return member.trim();
        }
      } catch (_) {}
    }
    return "";
  }
  async function startNfc() {
    if (!("NDEFReader" in window)) { setMessage($("scanMessage"), "قراءة NFC غير مدعومة في هذا المتصفح. استخدم Chrome على هاتف Android أو امسح الباركود.", true); return; }
    if (app.nfcAbort) return;
    stopCamera();
    try {
      const reader = new NDEFReader();
      app.nfcAbort = new AbortController();
      reader.onreading = event => {
        const token = nfcToken(event.message);
        if (!token) { setMessage($("scanMessage"), "البطاقة لا تحتوي مُعرّف APL GYM صالحًا. اربط بطاقة عضوية من ملف المتدرب.", true); return; }
        const now = Date.now();
        if (token === app.lastNfcToken && now - app.lastNfcAt < 5000) return;
        app.lastNfcToken = token;
        app.lastNfcAt = now;
        scan(token);
      };
      reader.onerror = () => setMessage($("scanMessage"), "تعذرت قراءة بطاقة NFC. تأكد من تشغيل NFC واستخدام بطاقة عضوية مهيأة.", true);
      await reader.scan({ signal: app.nfcAbort.signal });
      setMessage($("scanMessage"), "NFC جاهز. قرّب بطاقة العضوية من ظهر الهاتف؛ القراءة تعمل تلقائيًا ما دامت شاشة الحضور مفتوحة.");
    } catch (error) {
      stopNfc();
      const message = error?.name === "NotAllowedError" ? "لم يُسمح باستخدام NFC. امنح الإذن وحاول مجددًا." : error?.name === "NotSupportedError" ? "هذا الهاتف أو المتصفح لا يدعم قراءة NFC." : "تعذر بدء NFC. تأكد من تفعيل NFC واستخدام صفحة HTTPS في Chrome على Android.";
      setMessage($("scanMessage"), message, true);
    }
  }
  async function writeNfc() {
    if (!("NDEFReader" in window)) { setMessage($("formMessage"), "كتابة NFC غير مدعومة هنا؛ استخدم Chrome على Android.", true); return; }
    const memberToken = $("memberBarcode").value.trim() || $("memberNumber").value.trim();
    if (!memberToken) { setMessage($("formMessage"), "أدخل رقم العضوية أو الباركود أولًا.", true); return; }
    try {
      const reader = new NDEFReader();
      await reader.write({ records: [{ recordType: "text", data: `APL-GYM:${memberToken}`, lang: "en" }] });
      setMessage($("formMessage"), "تمت كتابة مُعرّف العضوية على بطاقة NFC. احفظ بيانات المتدرب لتفعيل المطابقة.");
    } catch (error) {
      const message = error?.name === "NotAllowedError" ? "لم يُسمح بكتابة NFC. امنح الإذن وحاول مجددًا." : "تعذرت كتابة البطاقة. قرّب بطاقة NFC فارغة وقابلة للكتابة من الهاتف.";
      setMessage($("formMessage"), message, true);
    }
  }
  function stopNfc() { if (app.nfcAbort) { app.nfcAbort.abort(); app.nfcAbort = null; } }
  function stopCamera(){if(app.scanTimer)clearTimeout(app.scanTimer);app.scanTimer=null;if(app.stream){app.stream.getTracks().forEach(t=>t.stop());app.stream=null;}const video=$("camera");if(video){video.pause();video.srcObject=null;video.hidden=true;}}
  function exportData(){const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),trainees:app.trainees},null,2)],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download=`apl-gym-${today()}.json`;link.click();URL.revokeObjectURL(link.href);}
  async function importData(file){try{const data=JSON.parse(await file.text());const list=Array.isArray(data)?data:data.trainees;if(!Array.isArray(list))throw new Error();if(!confirm(`سيتم استبدال بيانات الهاتف الحالية بـ ${list.length} متدرب. متابعة؟`))return;app.trainees=list;saveData();render();alert("تم استيراد النسخة الاحتياطية");}catch(_){alert("ملف النسخة الاحتياطية غير صالح");}}

  $("activateOnline").addEventListener("click",()=>activate(true));$("activateOffline").addEventListener("click",()=>activate(false));$("copyDevice").addEventListener("click",async()=>{try{await navigator.clipboard.writeText(deviceId);setMessage($("licenseMessage"),"تم نسخ معرّف الهاتف");}catch(_){setMessage($("licenseMessage"),deviceId);}});
  $("quickAdd").addEventListener("click",()=>openMember());$("addTrainee").addEventListener("click",()=>openMember());$("closeDialog").addEventListener("click",()=>$("memberDialog").close());$("memberForm").addEventListener("submit",saveMember);$("renewMember").addEventListener("click",renewMember);$("deleteMember").addEventListener("click",()=>{const id=$("memberId").value;if(confirm("حذف سجل هذا المتدرب؟")){app.trainees=app.trainees.filter(t=>String(t.id)!==id);saveData();render();$("memberDialog").close();}});$("subscriptionType").addEventListener("change",updateTypeFields);$("search").addEventListener("input",render);
  document.querySelectorAll("[data-page]").forEach(button=>button.addEventListener("click",()=>{const page=button.dataset.page;showPage(page);if(page==="attendancePage")startNfc();}));
  document.querySelectorAll(".filter").forEach(button=>button.addEventListener("click",()=>{app.filter=button.dataset.filter;document.querySelectorAll(".filter").forEach(b=>b.classList.toggle("active",b===button));render();}));
  $("scanPcPairing").addEventListener("click",startPairCamera);
  $("connectPcCode").addEventListener("click",connectUsingCode);
  $("pcPairCode").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();connectUsingCode();}});
  $("disconnectPc").addEventListener("click",()=>{if(!confirm("فصل هذا الهاتف عن الكمبيوتر؟ تبقى بيانات القاعة محفوظة على الكمبيوتر."))return;stopPairCamera();app.pcLink=null;app.pcRevision="";app.pcBaseSnapshot=[];app.pcPending=null;app.pcDirty=false;localStorage.removeItem(PC_LINK);loadLocalData();render();updatePcLinkControls();setMessage($("pcLinkMessage"),"تم فصل الكمبيوتر. بيانات القاعة ما زالت محفوظة عليه.");});
  $("submitBarcode").addEventListener("click",()=>scan($("barcodeInput").value));$("barcodeInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();scan(e.currentTarget.value);}});$("startScan").addEventListener("click",startCamera);$("writeNfc").addEventListener("click",writeNfc);$("exportData").addEventListener("click",exportData);$("importData").addEventListener("change",e=>{if(e.target.files[0])importData(e.target.files[0]);e.target.value="";});$("showLicense").addEventListener("click",async()=>{const code=localStorage.getItem(LICENSE);const result=code?await verifyLicense(code):null;alert(result?.valid?`الترخيص نشط${result.data.expires?` حتى ${new Date(result.data.expires).toLocaleDateString("ar-DZ")}`:""}`:"لا يوجد ترخيص فعال");});$("deleteAll").addEventListener("click",()=>{const message=app.pcLink?"سيتم حذف جميع بيانات المتدربين من الكمبيوتر الأساسي نهائيًا. لا يمكن التراجع. هل تريد المتابعة؟":"سيتم حذف جميع بيانات المتدربين المحفوظة على هذا الهاتف. لا يمكن التراجع. هل تريد المتابعة؟";if(confirm(message)){app.trainees=[];saveData();render();}});
  window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();app.deferredInstall=event;$("install").hidden=false;});$("install").addEventListener("click",async()=>{if(!app.deferredInstall)return;app.deferredInstall.prompt();await app.deferredInstall.userChoice.catch(()=>null);app.deferredInstall=null;$("install").hidden=true;});window.addEventListener("pagehide",()=>{stopCamera();stopNfc();stopPairCamera();});
  if("serviceWorker" in navigator)navigator.serviceWorker.register("/manager/sw.js",{scope:"/manager/"}).catch(()=>{});
  loadData().finally(()=>checkLicense());window.setInterval(()=>{if(!$("licenseScreen").hidden)return;checkLicense();},60_000);window.setInterval(pollComputer,4_000);
})();
