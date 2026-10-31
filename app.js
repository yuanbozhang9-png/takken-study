import {CONFIG} from './config.js';
import {DEFAULT_EXAM,jpDate,toDay,dateFromDay,lifeModel,countdown,calendarCells,heatLevel,statistics,validateBackup,randomQuestion,UUID,newId} from './core.js';
const $=id=>document.getElementById(id);
let cloud=null,user=null,profile=null,questions=[],records=[],current=null,selected=null,done=false,busy=false,authBusy=false,pending=null,authEpoch=0,refreshTask=null,restoreBusy=false;
let rememberedDay=jpDate(),lastRefresh=0;
const PENDING_KEY='takken-pending-v2';
const questionColumns='id,exam_year,question_number,category,correct_options,source_url,source_page,explanation';
const answerColumns='id,user_id,studied_on,question_id,selected_option,is_correct,created_at,entry_kind';
function message(id,text,error=false){$(id).textContent=text;$(id).className='note'+(error?' error':'');}
function errorText(err){
  if (!navigator.onLine) return '当前没有网络连接';
  const code=err?.code;
  if(code==='42501'||String(err?.message||'').includes('Not authorized'))return '账号未被授权，或尚未绑定唯一账号';
  if(code==='PGRST202'||code==='42P01')return '数据库初始化或函数尚未部署';
  return String(err?.message||'网络或服务暂时不可用').slice(0,240);
}
function showClock(){
  const target=profile?.exam_at||DEFAULT_EXAM,parts=countdown(target);
  $('clock').textContent=`${parts[0]}天 ${String(parts[1]).padStart(2,'0')}时 ${String(parts[2]).padStart(2,'0')}分 ${String(parts[3]).padStart(2,'0')}秒`;
  const local=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',dateStyle:'long',timeStyle:'short'}).format(new Date(target));
  $('examLabel').textContent=local+'（日本时间；个人暂定日期，非官方确认日期）';
}
function renderLife(){
  $('life').replaceChildren();$('pastStat').textContent='';$('futureStat').textContent='';
  if(!profile?.birthday){$('lifeLock').hidden=false;return;}
  try{
    const model=lifeModel(profile.birthday);$('lifeLock').hidden=true;
    $('pastStat').textContent=`过去 ${model.past.toLocaleString()} 天（不含今天）`;
    $('futureStat').textContent=`剩余 ${model.remaining.toLocaleString()} 天（含今天）`;
    const frag=document.createDocumentFragment();
    for(const row of model.rows){
      const outer=document.createElement('div');outer.className='life-row';
      const label=document.createElement('span');label.className='age';label.textContent=row.age;label.title=`${row.age}岁`;
      const cells=document.createElement('div');cells.className='days';cells.style.gridTemplateColumns=`repeat(${row.end-row.start},minmax(0,1fr))`;
      cells.setAttribute('aria-label',`${row.age}岁，共${row.end-row.start}天`);
      for(let d=row.start;d<row.end;d++){
        const cell=document.createElement('span');cell.className='day'+(d<model.current?' past':d===model.current?' today':'');cell.title=dateFromDay(d);cells.append(cell);
      }
      outer.append(label,cells);frag.append(outer);
    }
    $('life').append(frag);
  }catch(e){$('lifeLock').hidden=false;$('lifeLock').textContent='出生日期无效，请重新设置。';}
}
function renderHeat(){
  const stats=statistics(records),year=+$('heatYear').value||+jpDate().slice(0,4),today=jpDate();
  $('counter').textContent=`累计打卡 ${stats.days} 天 · 答题 ${stats.quantity} 道 · 正确率 ${stats.accuracy===null?'—':(stats.accuracy*100).toFixed(1)+'%'} · 今日 ${stats.counts.get(today)||0} 道`;
  const days=calendarCells(year),frag=document.createDocumentFragment();let yearly=0,active=0;
  for(const date of days){
    const cell=document.createElement('button');cell.type='button';cell.className='cell';
    if(!date){cell.classList.add('blank');cell.disabled=true;cell.tabIndex=-1;cell.setAttribute('aria-hidden','true');}
    else{const n=stats.counts.get(date)||0;yearly+=n;if(n)active++;const level=heatLevel(n);if(level)cell.classList.add('l'+level);if(date===today)cell.classList.add('current');cell.title=`${date}：${n}题`;cell.setAttribute('aria-label',cell.title);cell.onclick=()=>{$('lookupDay').value=date;lookupDay();};}
    frag.append(cell);
  }
  $('heat').replaceChildren(frag);$('yearCounter').textContent=`${year}年 · 打卡 ${active} 天 · 答题 ${yearly} 道`;
  const years=new Set([+today.slice(0,4),+today.slice(0,4)-1,+today.slice(0,4)+1,year,...records.map(x=>Number(x.studied_on.slice(0,4)))]);
  $('heatYear').replaceChildren(...[...years].sort((a,b)=>b-a).map(n=>new Option(n,n)));$('heatYear').value=year;
  $('heatMonths').replaceChildren(...Array.from({length:12},(_,i)=>{const s=document.createElement('span');s.textContent=(i+1)+'月';return s;}));
  if(!$('lookupDay').value)$('lookupDay').value=today;
  lookupDay();resizeHeat();
}
function resizeHeat(){const width=$('heat').parentElement.clientWidth;if(width>0)$('heat').style.setProperty('--heat-cell',Math.max(3,Math.min(10,(width-2*52)/53))+'px');}
function lookupDay(){const d=$('lookupDay').value;const n=statistics(records).counts.get(d)||0;$('heatDetail').textContent=`${n} 道已保存答案`;}
function updateFilters(){const locked=busy||!!pending||restoreBusy;$('yearFilter').disabled=locked;$('categoryFilter').disabled=locked;}
function savePending(){if(!user)return;try{if(pending)sessionStorage.setItem(PENDING_KEY,JSON.stringify({...pending,owner_id:user.id}));else sessionStorage.removeItem(PENDING_KEY);}catch{message('feedback','浏览器无法保留待确认提交。网络出错后请勿关闭此页。',true);}}
function loadPending(){try{const p=JSON.parse(sessionStorage.getItem(PENDING_KEY));return p&&p.owner_id===user?.id&&UUID.test(p.id)&&typeof p.question_id==='string'&&Number.isInteger(p.selected_option)&&p.selected_option>=0&&p.selected_option<4?p:null;}catch{return null;}}
function showQuestion(q,restoreSelection=null){
  current=q;done=false;selected=restoreSelection;$('answers').replaceChildren();$('explanation').replaceChildren();$('next').hidden=true;$('submit').textContent=pending?'重试确认保存':'提交并打卡';message('feedback','');$('pdfPanel').open=false;$('sourceFrame').removeAttribute('src');
  if(!q){$('question').textContent='此筛选下暂无已核验题目。';$('questionMeta').textContent='';$('sourceLink').hidden=true;$('submit').disabled=true;$('pdfPanel').hidden=true;return;}
  $('pdfPanel').hidden=false;$('questionMeta').textContent=`${q.exam_year}年 · 問${q.question_number} · ${q.category}`;
  $('question').textContent=`请阅读 ${q.exam_year} 年官方试卷的「問${q.question_number}」，选择其中的答案编号。`;
  const url=q.source_url+(q.source_page?'#page='+q.source_page:'');$('sourceLink').href=url;$('sourceLink').hidden=false;
  for(let i=0;i<4;i++){
    const btn=document.createElement('button');btn.type='button';btn.className='answer';btn.textContent=`选项 ${i+1}`;btn.setAttribute('aria-pressed',String(i===selected));if(i===selected)btn.classList.add('selected');
    btn.onclick=()=>{if(done||busy||pending)return;selected=i;[...$('answers').children].forEach((b,j)=>{b.classList.toggle('selected',i===j);b.setAttribute('aria-pressed',String(i===j));});$('submit').disabled=false;};$('answers').append(btn);
  }
  $('submit').disabled=selected===null||busy;
  if(pending)message('feedback','上次提交尚未确认，请重试。同一提交ID不会重复增加答题次数。');updateFilters();
}
function pickQuestion(){
  const year=$('yearFilter').value,category=$('categoryFilter').value;
  const pool=questions.filter(q=>(year==='all'||String(q.exam_year)===year)&&(category==='all'||q.category===category));
  showQuestion(randomQuestion(pool,current?.id));
}
function renderExplanation(q,row){
  const root=$('explanation');root.replaceChildren();
  const summary=document.createElement('p');summary.className='note';summary.textContent=q.explanation?.summary||'已按官方标准答案核对。中文逐项解析及相关法条尚未核验，不补写推测性解释。';root.append(summary);
  for(const law of q.explanation?.laws||[]){
    const box=document.createElement('div');box.className='laws';
    const a=document.createElement('a');a.href=law.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=law.article+' · e-Gov';
    const ja=document.createElement('p');ja.lang='ja';ja.textContent='日文原文：'+law.ja;const zh=document.createElement('p');zh.textContent='中文翻译：'+law.zh;box.append(a,ja,zh);root.append(box);
  }
  const source=document.createElement('a');source.target='_blank';source.rel='noopener noreferrer';source.textContent='核对官方标准答案（PDF末页）';source.href=q.source_url;root.append(source);
  message('feedback',`${row.is_correct?'回答正确':'回答错误'} · 官方正确选项 ${q.correct_options.map(n=>n+1).join('、')}\n打卡已同步到云端 · ${row.studied_on}（日本日期）`);
}
async function getAllAnswers(epoch){
  const rows=[];let after=null;
  for(let page=0;page<1000;page++){
    let query=cloud.from('study_answers').select(answerColumns).eq('user_id',user.id).order('id',{ascending:true}).limit(500);
    if(after)query=query.gt('id',after);
    const {data,error}=await query;if(error)throw error;if(epoch!==authEpoch)throw Error('账号已切换');
    rows.push(...(data||[]));if(!data||data.length<500)return rows;after=data[data.length-1].id;
  }
  throw Error('记录超过读取上限，请先联系维护者；未导出不完整备份');
}
async function refreshRecords(){
  if(!cloud||!user)return false;if(refreshTask)return refreshTask;
  const epoch=authEpoch;
  const task=(async()=>{try{const data=await getAllAnswers(epoch);if(epoch!==authEpoch)return false;records=data;lastRefresh=Date.now();renderHeat();$('syncStatus').textContent='完整云端记录已同步 · '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',timeStyle:'medium'}).format(new Date())+'（日本时间）';return true;}catch(e){if(epoch===authEpoch)$('syncStatus').textContent='读取失败：'+errorText(e)+'。暂保留上次已确认记录。';return false;}finally{if(refreshTask===task)refreshTask=null;}})();refreshTask=task;return task;
}
async function submitAnswer(){
  if(selected===null||done||busy||restoreBusy||!cloud||!user||!current)return;
  const epoch=authEpoch,q=current,uid=user.id;
  if(!pending){try{pending={id:newId(),question_id:q.id,selected_option:selected};savePending();}catch(e){message('feedback',errorText(e),true);return;}}
  busy=true;$('submit').disabled=true;$('submit').textContent='云端确认中…';updateFilters();
  try{
    const {data,error}=await cloud.rpc('submit_study_answer',{p_id:pending.id,p_question_id:pending.question_id,p_selected_option:pending.selected_option});if(error)throw error;
    if(epoch!==authEpoch)return;
    const row=Array.isArray(data)?data[0]:data;
    if(!row||row.id!==pending.id||row.user_id!==uid||row.question_id!==q.id||row.selected_option!==selected||typeof row.is_correct!=='boolean')throw Error('云端未返回可验证的保存结果');
    records=[...records.filter(x=>x.id!==row.id),row];done=true;pending=null;savePending();
    [...$('answers').children].forEach((b,i)=>{b.disabled=true;b.classList.toggle('correct',q.correct_options.includes(i));});$('next').hidden=false;
    renderExplanation(q,row);renderHeat();await refreshRecords();
  }catch(e){if(epoch===authEpoch)message('feedback','保存未确认，尚未显示打卡成功：'+errorText(e)+'。请重试确认，系统会防止重复。',true);}
  finally{if(epoch===authEpoch){busy=false;$('submit').disabled=done||selected===null;$('submit').textContent=done?'已保存':pending?'重试确认保存':'提交并打卡';updateFilters();}}
}
async function loadProfile(epoch){
  const {data,error}=await cloud.from('study_profile').select('birthday,exam_at').eq('user_id',user.id).maybeSingle();if(error)throw error;if(epoch!==authEpoch)return;
  profile=data;renderLife();showClock();$('birthday').value=data?.birthday||'';
  const target=data?.exam_at||DEFAULT_EXAM;$('examAt').value=new Date(Date.parse(target)+9*3600000).toISOString().slice(0,16);
  if(!data){$('profilePanel').open=true;message('profileMessage','请先保存出生日期，或由管理员运行私人账号初始化脚本。');}
}
async function applySession(session){
  const next=session?.user||null;
  if(user?.id===next?.id && user!==null)return;
  const epoch=++authEpoch;user=next;profile=null;records=[];questions=[];current=null;selected=null;done=false;busy=false;pending=null;refreshTask=null;
  $('password').value='';$('birthday').value='';$('examAt').value='';$('sourceFrame').removeAttribute('src');$('studyArea').hidden=true;$('profilePanel').hidden=true;$('logout').hidden=!user;$('authForm').hidden=!!user;$('authStatus').textContent=user?'已登录，检查本人访问权限…':'未登录 · 请使用本人的邮箱登录';
  $('explanation').replaceChildren();message('feedback','');message('authMessage','');renderLife();showClock();renderHeat();
  if(!user)return;
  try{
    const {data:allowed,error:ownerError}=await cloud.rpc('is_study_owner');if(ownerError)throw ownerError;if(!allowed)throw Error('账号未被授权，或管理员尚未绑定唯一账号');
    if(epoch!==authEpoch)return;
    await loadProfile(epoch);
    const {data,error}=await cloud.from('study_questions').select(questionColumns).order('id',{ascending:true}).limit(200);if(error)throw error;if(epoch!==authEpoch)return;
    questions=(data||[]).filter(q=>q.id&&q.exam_year>=2024&&q.exam_year<=2026&&q.correct_options?.length&&/^https:\/\/www\.retio\.or\.jp\//.test(q.source_url));
    $('authStatus').textContent='已登录：'+user.email;$('studyArea').hidden=false;$('profilePanel').hidden=false;
    const full=questions.filter(q=>q.explanation).length;$('bankStatus').textContent=`已核验官方答案 ${questions.length} 道 · 中文解析 ${full} 道 · 2026年待官方答案；无演示题。`;
    pending=loadPending();const pendingQ=questions.find(q=>q.id===pending?.question_id);
    if(pending&&!pendingQ){message('authMessage','本浏览器有未确认提交，但该题目不在已核验题库。请先核查旧记录，暂不继续答题。',true);$('submit').disabled=true;showQuestion(null);return;}
    if(pendingQ)showQuestion(pendingQ,pending.selected_option);else pickQuestion();
    await refreshRecords();resizeHeat();
  }catch(e){if(epoch===authEpoch)message('authMessage','初始化失败：'+errorText(e)+'。私人学习区域未开放。',true);}
}
async function timeoutFetch(input,init={}){
  const control=new AbortController(),abort=()=>control.abort();if(init.signal?.aborted)control.abort();else init.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,20000);try{return await fetch(input,{...init,signal:control.signal});}finally{clearTimeout(timer);init.signal?.removeEventListener('abort',abort);}
}
export async function connectClient(client){
  cloud=client;const {data,error}=await cloud.auth.getSession();if(error)throw error;await applySession(data.session);
  cloud.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||event==='SIGNED_IN'||event==='INITIAL_SESSION')setTimeout(()=>applySession(session),0);});
}
async function startCloud(){
  $('retryCloud').hidden=true;
  if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(CONFIG.SUPABASE_URL)||!CONFIG.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')){
    $('authStatus').textContent='尚未部署云端配置。倒计时可用；登录、私人时间轴及答题同步等待配置。';return;
  }
  try{
    const module=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.8/+esm');
    await connectClient(module.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_PUBLISHABLE_KEY,{global:{fetch:timeoutFetch},auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}));
  }catch(e){$('authStatus').textContent='连接云端失败：'+errorText(e);$('retryCloud').hidden=false;}
}
$('authForm').onsubmit=async e=>{
  e.preventDefault();if(!cloud||authBusy)return;authBusy=true;$('login').disabled=true;message('authMessage','登录中…');
  try{const {data,error}=await cloud.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw error;await applySession(data.session);}catch(e){message('authMessage','登录失败：'+errorText(e),true);}finally{authBusy=false;$('login').disabled=false;$('password').value='';}
};
$('signup').hidden=!CONFIG.ALLOW_SIGNUP;
$('signup').onclick=async()=>{
  if(!CONFIG.ALLOW_SIGNUP||!cloud||authBusy||!$('authForm').reportValidity())return;
  authBusy=true;$('signup').disabled=true;
  try{const {error}=await cloud.auth.signUp({email:$('email').value.trim(),password:$('password').value,options:{emailRedirectTo:location.origin+location.pathname}});if(error)throw error;message('authMessage','注册已提交。完成邮箱验证后，由管理员绑定此唯一账号并关闭公开注册。');}catch(e){message('authMessage','注册失败：'+errorText(e),true);}finally{authBusy=false;$('signup').disabled=false;$('password').value='';}
};
$('logout').onclick=async()=>{if(!cloud||busy||restoreBusy)return;try{const {error}=await cloud.auth.signOut({scope:'local'});if(error)throw error;await applySession(null);}catch(e){message('authMessage','退出失败：'+errorText(e),true);}};
$('profileForm').onsubmit=async e=>{
  e.preventDefault();if(!cloud||!user)return;const epoch=authEpoch;$('saveProfile').disabled=true;
  try{
    lifeModel($('birthday').value);const exam=$('examAt').value;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(exam))throw Error('考试时间无效');
    const payload={user_id:user.id,birthday:$('birthday').value,exam_at:exam+':00+09:00',updated_at:new Date().toISOString()};
    const {data,error}=await cloud.from('study_profile').upsert(payload,{onConflict:'user_id'}).select('birthday,exam_at').single();if(error)throw error;if(epoch!==authEpoch)return;
    profile=data;renderLife();showClock();message('profileMessage','私人时间设置已同步。');
  }catch(e){if(epoch===authEpoch)message('profileMessage','保存失败：'+errorText(e),true);}finally{$('saveProfile').disabled=false;}
};
$('submit').onclick=submitAnswer;$('next').onclick=()=>{if(!busy&&!pending)pickQuestion();};
$('yearFilter').onchange=()=>{if(!busy&&!pending)pickQuestion();};$('categoryFilter').onchange=()=>{if(!busy&&!pending)pickQuestion();};
$('pdfPanel').ontoggle=()=>{if($('pdfPanel').open&&current)$('sourceFrame').src=$('sourceLink').href;};
$('heatYear').onchange=renderHeat;$('lookupDay').onchange=lookupDay;$('refresh').onclick=async()=>{if(user){const epoch=authEpoch;try{await loadProfile(epoch);}catch(e){message('profileMessage','读取时间设置失败：'+errorText(e),true);}await refreshRecords();}};
$('retryCloud').onclick=startCloud;
$('export').onclick=async()=>{
  if(!user||restoreBusy)return;const epoch=authEpoch;$('export').disabled=true;
  try{
    if(!await refreshRecords()||epoch!==authEpoch)throw Error('未能取得完整云端记录，未生成备份');
    const backup={format:'takken-study',version:2,owner_id:user.id,exported_at:new Date().toISOString(),profile,answers:records.filter(x=>x.entry_kind!=='legacy'),legacy_answers:records.filter(x=>x.entry_kind==='legacy')};
    const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`takken-study-backup-${jpDate()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);message('restoreStatus','备份已生成，包含私人设置，请妥善保管。旧演示记录仅归档，不参与正式打卡统计。');
  }catch(e){message('restoreStatus',errorText(e),true);}finally{$('export').disabled=false;}
};
$('import').onclick=()=>{if(user&&!busy&&!restoreBusy&&!pending)$('importFile').click();else message('restoreStatus','请先完成当前提交，再恢复备份。',true);};
$('importFile').onchange=async()=>{
  const file=$('importFile').files[0];if(!file||!user)return;const epoch=authEpoch;let imported=0,skipped=0;
  try{
    if(file.size>20*1024*1024)throw Error('备份超过20MB上限');
    const backup=JSON.parse(await file.text());const rows=validateBackup(backup,user.id,new Set(questions.map(q=>q.id)));
    if(!confirm(`恢复 ${rows.length} 条答题记录？已有相同ID会跳过，不删除或覆盖现有记录；私人时间设置保留当前值。`))return;
    restoreBusy=true;updateFilters();$('import').disabled=true;$('export').disabled=true;$('logout').disabled=true;$('submit').disabled=true;
    for(let i=0;i<rows.length;i+=500){
      if(epoch!==authEpoch)throw Error('账号已切换，停止恢复');
      const {data,error}=await cloud.rpc('restore_study_answers',{p_rows:rows.slice(i,i+500)});if(error)throw error;
      if(!data||!Number.isInteger(data.added)||!Number.isInteger(data.skipped))throw Error('未收到有效恢复结果');
      imported+=data.added;skipped+=data.skipped;message('restoreStatus',`恢复中：已新增 ${imported} 条，跳过重复 ${skipped} 条。`);
    }
    message('restoreStatus',`恢复完成：新增 ${imported} 条，跳过重复 ${skipped} 条。时间设置保留当前值，备份中旧演示记录未导入。`);
  }catch(e){message('restoreStatus',`恢复未完成：${errorText(e)}。已确认新增 ${imported} 条、跳过 ${skipped} 条；网络出错时实际可能已保存更多。可用同一备份重试，系统按ID去重。`,true);}
  finally{
    $('importFile').value='';restoreBusy=false;$('import').disabled=false;$('export').disabled=false;$('logout').disabled=false;$('submit').disabled=done||selected===null;updateFilters();
    if(user&&epoch===authEpoch)await refreshRecords();
  }
};
$('heatYear').append(new Option(jpDate().slice(0,4),jpDate().slice(0,4)));
if(typeof ResizeObserver!=='undefined')new ResizeObserver(resizeHeat).observe($('heat').parentElement);
window.addEventListener('resize',resizeHeat);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){showClock();if(jpDate()!==rememberedDay){rememberedDay=jpDate();renderLife();renderHeat();}if(user&&Date.now()-lastRefresh>10000&&!restoreBusy)refreshRecords();}});
setInterval(()=>{showClock();if(jpDate()!==rememberedDay){rememberedDay=jpDate();renderLife();renderHeat();}},1000);
setInterval(()=>{if(user&&!document.hidden&&!restoreBusy)refreshRecords();},30000);
renderLife();showClock();renderHeat();startCloud();
