import {CONFIG} from './config.js';
import {CHECKIN_MS,DEFAULT_EXAM,jpDate,toDay,dateFromDay,lifeModel,nextBirthday,countdown,calendarCells,statistics,validateBackup,validateStudySessions,formatStudyDuration,extendDailyStudyTime,studyPeriodStarts,randomQuestion,UUID,newId} from './core.js?v=timed-checkin';
const $=id=>document.getElementById(id);
let cloud=null,user=null,profile=null,questions=[],records=[],current=null,selected=null,done=false,busy=false,authBusy=false,pending=null,authEpoch=0,refreshTask=null,restoreBusy=false;
let rememberedDay=jpDate(),lastRefresh=0;
let birthdayTarget = null;
let timerState = null, timerTask = null, timerReady = false, timerChanging = false;
let heatToday = '', heatTodayChecked = false;
let correctionRecords = null, correctionLoad = null, correctionDraftId = null;
const PENDING_KEY='takken-pending-v2';
const questionColumns='id,exam_year,question_number,category,correct_options,source_url,source_page,explanation';
const answerColumns='id,user_id,studied_on,question_id,selected_option,is_correct,created_at,entry_kind';
const sessionColumns = 'id,started_at,ended_at';
function message(id,text,error=false){$(id).textContent=text;$(id).className='note'+(error?' error':'');}
function errorText(err){
  if (!navigator.onLine) return '当前没有网络连接';
  const code=err?.code;
  if(code==='42501'||String(err?.message||'').includes('Not authorized'))return '账号未被授权，或尚未绑定唯一账号';
  if(code==='PGRST202'||code==='42P01')return '数据库初始化或函数尚未部署';
  return String(err?.message||'网络或服务暂时不可用').slice(0,240);
}
function renderCountdown(clockId, target, now) {
  const clock = $(clockId);
  const dayValue = clock.querySelector('.countdown-day-value');
  const time = clock.querySelector('.countdown-time');
  if (!target) {
    dayValue.textContent = '';
    time.textContent = '';
    return;
  }
  const [days, hours, minutes, seconds] = countdown(target, now);
  const twoDigits = value => String(value).padStart(2, '0');
  dayValue.textContent = String(days);
  time.textContent = `${twoDigits(hours)}时 ${twoDigits(minutes)}分 ${twoDigits(seconds)}秒`;
}
function showClock(){
  const now = Date.now();
  const target = profile?.exam_at || DEFAULT_EXAM;
  renderCountdown('clock', target, now);
  if (birthdayTarget && now >= Date.parse(birthdayTarget)) {
    birthdayTarget = nextBirthday(profile.birthday, now);
  }
  $('birthdayCountdown').hidden = !birthdayTarget;
  renderCountdown('birthdayClock', birthdayTarget, now);
  const local=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',dateStyle:'long',timeStyle:'short'}).format(new Date(target));
  $('examLabel').textContent=local+'（日本时间；个人暂定日期，非官方确认日期）';
}
function studyNow() {
  return timerState
    ? timerState.serverNow + Math.max(0, performance.now() - timerState.receivedAt)
    : Date.now();
}

function dailyStudyTime(now) {
  if (!timerState) return new Map();
  const {dailyMs, active, serverNow} = timerState;
  return active ? extendDailyStudyTime(dailyMs, Math.max(serverNow, active.startedAt), now) : dailyMs;
}

function renderStudyTimer(refreshCalendar = false) {
  if (!timerState) {
    for (const id of ['studyElapsed', 'studyMonth', 'studyWeek', 'studyDay']) $(id).textContent = '—';
    $('studyCurrent').hidden = true;
    $('studyCurrent').textContent = '';
    $('studyCheckin').hidden = true;
    $('studyCheckin').textContent = '';
    return;
  }
  const {active, periodStarts, totalMs, monthMs, weekMs} = timerState;
  const now = studyNow();
  const periods = studyPeriodStarts(now);
  const runningSince = start => active ? Math.max(0, now - Math.max(active.startedAt, start)) : 0;
  $('studyElapsed').textContent = formatStudyDuration(totalMs + runningSince(0));
  $('studyMonth').textContent = formatStudyDuration(
    (periods.month === periodStarts.month ? monthMs : 0) + runningSince(periods.month)
  );
  $('studyWeek').textContent = formatStudyDuration(
    (periods.week === periodStarts.week ? weekMs : 0) + runningSince(periods.week)
  );
  $('studyCurrent').hidden = !active;
  $('studyCurrent').textContent = active ? '计时中 · 本次 ' + formatStudyDuration(runningSince(0)) : '';

  const daily = dailyStudyTime(now);
  const today = jpDate(new Date(now));
  const todayMs = daily.get(today) ?? 0;
  $('studyDay').textContent = formatStudyDuration(todayMs);
  const checked = todayMs >= CHECKIN_MS;
  const status = checked ? '今日已打卡' : '今日未打卡';
  $('studyCheckin').hidden = false;
  if ($('studyCheckin').textContent !== status) $('studyCheckin').textContent = status;
  if (refreshCalendar || today !== heatToday || checked !== heatTodayChecked) renderHeat(daily, today);
  else if (active) lookupDay(daily);
}

function updateTimerButtons() {
  const locked = timerChanging || restoreBusy || !!correctionLoad;
  $('startStudy').textContent = !timerReady && !timerTask ? '重新读取计时' : '开始学习';
  $('startStudy').disabled = locked || (!timerReady && !!timerTask) || (timerReady && !!timerState?.active);
  $('stopStudy').disabled = locked || !timerReady || !timerState?.active;
  $('studyCorrectionFields').disabled = locked || !correctionRecords;
}

function acceptTimerState(data) {
  const serverNow = Date.parse(data?.server_now);
  const startedAt = data?.active ? Date.parse(data.active.started_at) : null;
  const totals = [data?.total_ms, data?.month_ms, data?.week_ms];
  const daily = data?.daily_ms;
  if (!Number.isFinite(serverNow) || totals.some(n => !Number.isSafeInteger(n) || n < 0)
    || !daily || typeof daily !== 'object' || Array.isArray(daily)
    || Object.values(daily).some(n => !Number.isSafeInteger(n) || n < 0)
    || (data?.active && (!UUID.test(data.active.id) || !Number.isFinite(startedAt)))) {
    throw new Error('未收到有效的云端计时状态');
  }
  timerState = {
    active: data.active ? {id: data.active.id, startedAt} : null,
    serverNow,
    receivedAt: performance.now(),
    periodStarts: studyPeriodStarts(serverNow),
    totalMs: data.total_ms,
    monthMs: data.month_ms,
    weekMs: data.week_ms,
    dailyMs: new Map(Object.entries(daily))
  };
  timerReady = true;
  renderStudyTimer(true);
}

async function refreshStudyTimer() {
  if (!user || $('studyTimer').hidden || timerChanging || restoreBusy) return false;
  if (timerTask) return timerTask;
  const epoch = authEpoch;
  const task = (async () => {
    try {
      const {data, error} = await cloud.rpc('get_study_timer');
      if (error) throw error;
      if (epoch !== authEpoch) return false;
      acceptTimerState(data);
      message('studyTimerStatus', '');
      return true;
    } catch (e) {
      if (epoch === authEpoch) {
        timerReady = false;
        message('studyTimerStatus', '读取计时失败：' + errorText(e), true);
      }
      return false;
    }
  })();
  timerTask = task;
  updateTimerButtons();
  try {
    return await task;
  } finally {
    if (timerTask === task) {
      timerTask = null;
      updateTimerButtons();
    }
  }
}

async function changeStudyTimer(action) {
  if (!user || $('studyTimer').hidden || timerChanging || restoreBusy || correctionLoad) return;
  if (!timerReady) {
    if (action === 'start') await refreshStudyTimer();
    return;
  }
  const activeId = timerState.active?.id;
  if ((action === 'stop') !== !!activeId) return;
  const epoch = authEpoch;
  let saved = false;
  timerChanging = true;
  updateTimerButtons();
  try {
    // Wait for any existing read, and never stop a different session from the one shown.
    if (timerTask) await timerTask;
    if (epoch !== authEpoch || !timerReady || timerState.active?.id !== activeId) return;
    const id = activeId || newId();
    message('studyTimerStatus', action === 'start' ? '正在开始计时…' : '正在保存学习时长…');
    const {data, error} = await cloud.rpc('change_study_timer', {p_action: action, p_id: id});
    if (error) throw error;
    if (epoch !== authEpoch) return;
    acceptTimerState(data);
    saved = true;
    message('studyTimerStatus', action === 'stop' ? '学习时长已保存。' : '');
  } catch (e) {
    if (epoch === authEpoch) {
      timerReady = false;
      message('studyTimerStatus', '计时状态未确认：' + errorText(e) + '。请重新读取计时。', true);
    }
  } finally {
    if (epoch === authEpoch) {
      timerChanging = false;
      updateTimerButtons();
    }
  }
  if (epoch === authEpoch && (saved || !correctionRecords)) {
    const preferredId = saved ? (action === 'start' ? timerState.active?.id : activeId) : undefined;
    await loadStudyCorrections(preferredId);
  }
}

function japanStudyInput(timestamp) {
  return timestamp ? new Date(Date.parse(timestamp) + 9 * 3600000).toISOString().slice(0, 19) : '';
}

function parseStudyInput(value, original) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(value)) {
    throw new Error('请填写有效的日期和时间。');
  }
  toDay(value.slice(0, 10));
  const time = Date.parse(value + (value.length === 16 ? ':00' : '') + '+09:00');
  // Keep the original milliseconds when the visible value was left unchanged.
  return Math.floor(Date.parse(original) / 1000) * 1000 === time
    ? original : new Date(time).toISOString();
}

function fillStudyCorrection() {
  const record = correctionRecords?.get($('studyCorrectionRecord').value);
  const running = !!record && record.ended_at === null;
  $('studyCorrectionStart').value = japanStudyInput(record?.started_at);
  $('studyCorrectionEnd').value = japanStudyInput(record?.ended_at);
  $('studyCorrectionEnd').required = !running;
  $('studyCorrectionEndHint').hidden = !running;
  correctionDraftId = null;
}

function showStudyCorrectionRecords(preferredId) {
  const ordered = [...correctionRecords.values()].sort((a, b) =>
    Number(a.ended_at !== null) - Number(b.ended_at !== null)
    || Date.parse(b.started_at) - Date.parse(a.started_at)
  );
  const select = $('studyCorrectionRecord');
  select.replaceChildren(new Option('补记一段学习', 'new'));
  for (const record of ordered) {
    const start = japanStudyInput(record.started_at).slice(0, 16);
    const end = japanStudyInput(record.ended_at).slice(0, 16);
    const startLabel = start.replace('T', ' ');
    const endLabel = end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end.replace('T', ' ');
    const label = end ? `${startLabel} ～ ${endLabel}` : `进行中 · ${startLabel}`;
    select.add(new Option(label, record.id));
  }
  const running = ordered.find(record => record.ended_at === null);
  select.value = preferredId === 'new' || correctionRecords.has(preferredId)
    ? preferredId : running?.id || 'new';
  fillStudyCorrection();
}

async function loadStudyCorrections(preferredId) {
  if (!user || $('studyTimer').hidden || !$('studyCorrection').open || timerChanging || restoreBusy) return false;
  if (correctionLoad) return correctionLoad;
  const epoch = authEpoch;
  message('studyCorrectionStatus', '正在读取学习记录…');
  const task = (async () => {
    try {
      const rows = await getAllRows('study_sessions', sessionColumns, epoch, true);
      if (epoch !== authEpoch) return false;
      correctionRecords = new Map(rows.map(record => [record.id, record]));
      showStudyCorrectionRecords(preferredId);
      message('studyCorrectionStatus', '');
      return true;
    } catch (e) {
      if (epoch === authEpoch) {
        correctionRecords = null;
        message('studyCorrectionStatus', '读取学习记录失败。请收起后重新打开。' + errorText(e), true);
      }
      return false;
    }
  })();
  correctionLoad = task;
  updateTimerButtons();
  try {
    return await task;
  } finally {
    if (correctionLoad === task) {
      correctionLoad = null;
      updateTimerButtons();
    }
  }
}

async function saveStudyCorrection(event) {
  event.preventDefault();
  if (!user || $('studyTimer').hidden || !correctionRecords || correctionLoad || timerChanging || restoreBusy) return;
  const selectedId = $('studyCorrectionRecord').value;
  const original = correctionRecords.get(selectedId);
  const epoch = authEpoch;
  let stale = false;
  let id;
  let startedAt;
  let endedAt;
  try {
    startedAt = parseStudyInput($('studyCorrectionStart').value, original?.started_at);
    endedAt = parseStudyInput($('studyCorrectionEnd').value, original?.ended_at);
    if (!startedAt || (!endedAt && (!original || original.ended_at !== null))) {
      throw new Error('请填写学习的开始和结束时间。');
    }
    if (endedAt && Date.parse(endedAt) <= Date.parse(startedAt)) {
      throw new Error('结束时间须晚于开始时间。');
    }
    id = original?.id || (correctionDraftId ??= newId());
  } catch (e) {
    message('studyCorrectionStatus', errorText(e), true);
    return;
  }
  timerChanging = true;
  updateTimerButtons();
  message('studyCorrectionStatus', '正在保存修正…');
  try {
    if (timerTask) await timerTask;
    if (epoch !== authEpoch) return;
    const {data, error} = await cloud.rpc('correct_study_session', {
      p_id: id,
      p_started_at: startedAt,
      p_ended_at: endedAt,
      p_original_started_at: original?.started_at ?? null,
      p_original_ended_at: original?.ended_at ?? null
    });
    if (error) throw error;
    if (epoch !== authEpoch) return;
    acceptTimerState(data);
    message('studyTimerStatus', '');
    correctionRecords.set(id, {id, started_at: startedAt, ended_at: endedAt});
    showStudyCorrectionRecords(id);
    message('studyCorrectionStatus', original ? '时间已修正。' : '学习时间已补记。');
  } catch (e) {
    if (epoch !== authEpoch) return;
    stale = e.code === '40001';
    const errors = {
      '40001': '这条记录已更新，请核对最新时间。',
      '23P01': '这段时间和已有学习记录重叠，请调整起止时间。',
      '22023': '请填写已发生的时间，结束须晚于开始。'
    };
    message('studyCorrectionStatus', errors[e.code] || '保存未确认，可用相同时间重试。' + errorText(e), true);
  } finally {
    if (epoch === authEpoch) {
      timerChanging = false;
      updateTimerButtons();
    }
  }
  if (stale && epoch === authEpoch) {
    const [loaded] = await Promise.all([loadStudyCorrections(id), refreshStudyTimer()]);
    if (loaded && epoch === authEpoch) {
      message('studyCorrectionStatus', '已载入最新时间，请核对后再修正。', true);
    }
  }
}
function renderLife(){
  birthdayTarget = null;
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
    birthdayTarget = nextBirthday(profile.birthday);
  }catch(e){$('lifeLock').hidden=false;$('lifeLock').textContent='出生日期无效，请重新设置。';}
}
function renderAnswerStats() {
  const stats = statistics(records);
  const accuracy = stats.accuracy === null ? '—' : (stats.accuracy * 100).toFixed(1) + '%';
  $('answerStats').textContent = `累计答题 ${stats.quantity} 道 · 正确率 ${accuracy} · 今日 ${stats.counts.get(jpDate()) ?? 0} 道`;
}

function checkinDetail(duration) {
  if (!timerState) return '等待同步计时记录';
  const status = duration >= CHECKIN_MS ? '已打卡' : '未打卡';
  return `${status} · 学习 ${formatStudyDuration(duration)}`;
}

function renderHeat(daily = dailyStudyTime(studyNow()), today = jpDate(new Date(studyNow()))) {
  const currentYear = Number(today.slice(0, 4));
  const year = Number($('heatYear').value) || currentYear;
  const frag = document.createDocumentFragment();
  let yearChecked = 0;
  for (const date of calendarCells(year)) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    if (!date) {
      cell.classList.add('blank');
      cell.disabled = true;
      cell.tabIndex = -1;
      cell.setAttribute('aria-hidden', 'true');
    } else {
      const duration = daily.get(date) ?? 0;
      const checked = duration >= CHECKIN_MS;
      if (checked) yearChecked++;
      cell.classList.toggle('checked', checked);
      cell.classList.toggle('current', date === today);
      cell.title = `${date} · ${checkinDetail(duration)}`;
      cell.setAttribute('aria-label', cell.title);
      cell.onclick = () => { $('lookupDay').value = date; lookupDay(); };
    }
    frag.append(cell);
  }
  $('heat').replaceChildren(frag);
  const totalChecked = [...daily.values()].filter(duration => duration >= CHECKIN_MS).length;
  $('checkinCounter').textContent = timerState
    ? `累计打卡 ${totalChecked} 天 · ${year} 年打卡 ${yearChecked} 天` : '等待同步计时记录';
  const years = new Set([currentYear, currentYear - 1, currentYear + 1, year,
    ...Array.from(daily.keys(), date => Number(date.slice(0, 4)))]);
  $('heatYear').replaceChildren(...[...years].sort((a,b)=>b-a).map(n=>new Option(n,n)));$('heatYear').value=year;
  $('heatMonths').replaceChildren(...Array.from({length:12},(_,i)=>{const s=document.createElement('span');s.textContent=(i+1)+'月';return s;}));
  if (!$('lookupDay').value || $('lookupDay').value === heatToday) $('lookupDay').value = today;
  heatToday = today;
  heatTodayChecked = (daily.get(today) ?? 0) >= CHECKIN_MS;
  lookupDay(daily);resizeHeat();
}
function resizeHeat(){const width=$('heat').parentElement.clientWidth;if(width>0)$('heat').style.setProperty('--heat-cell',Math.max(3,Math.min(10,(width-2*52)/53))+'px');}
function lookupDay(daily = dailyStudyTime(studyNow())) {
  const date = $('lookupDay').value;
  $('heatDetail').textContent = date ? checkinDetail(daily.get(date) ?? 0) : '';
}
function updateFilters(){const locked=busy||!!pending||restoreBusy;$('yearFilter').disabled=locked;$('categoryFilter').disabled=locked;}
function savePending(){if(!user)return;try{if(pending)sessionStorage.setItem(PENDING_KEY,JSON.stringify({...pending,owner_id:user.id}));else sessionStorage.removeItem(PENDING_KEY);}catch{message('feedback','浏览器无法保留待确认提交。网络出错后请勿关闭此页。',true);}}
function loadPending(){try{const p=JSON.parse(sessionStorage.getItem(PENDING_KEY));return p&&p.owner_id===user?.id&&UUID.test(p.id)&&typeof p.question_id==='string'&&Number.isInteger(p.selected_option)&&p.selected_option>=0&&p.selected_option<4?p:null;}catch{return null;}}
function showQuestion(q,restoreSelection=null){
  current=q;done=false;selected=restoreSelection;$('answers').replaceChildren();$('explanation').replaceChildren();$('next').hidden=true;$('submit').textContent=pending?'重试确认保存':'提交答案';message('feedback','');$('pdfPanel').open=false;$('sourceFrame').removeAttribute('src');
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
  message('feedback',`${row.is_correct?'回答正确':'回答错误'} · 官方正确选项 ${q.correct_options.map(n=>n+1).join('、')}\n答案已保存到云端 · ${row.studied_on}（日本日期）`);
}
async function getAllRows(table, columns, epoch, includeRunning = false){
  const rows=[];let after=null;
  for(let page=0;page<1000;page++){
    let query=cloud.from(table).select(columns).eq('user_id',user.id).order('id',{ascending:true}).limit(500);
    if(table==='study_sessions'&&!includeRunning)query=query.not('ended_at','is',null);
    if(after)query=query.gt('id',after);
    const {data,error}=await query;if(error)throw error;if(epoch!==authEpoch)throw Error('账号已切换');
    rows.push(...(data||[]));if(!data||data.length<500)return rows;after=data[data.length-1].id;
  }
  throw Error('记录超过读取上限，请先联系维护者；未导出不完整备份');
}
async function refreshRecords(){
  if(!cloud||!user)return false;if(refreshTask)return refreshTask;
  const epoch=authEpoch;
  const task=(async()=>{try{const data=await getAllRows('study_answers',answerColumns,epoch);if(epoch!==authEpoch)return false;records=data;lastRefresh=Date.now();renderAnswerStats();$('syncStatus').textContent='答题记录已同步 · '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Tokyo',timeStyle:'medium'}).format(new Date())+'（日本时间）';return true;}catch(e){if(epoch===authEpoch)$('syncStatus').textContent='答题记录读取失败：'+errorText(e)+'。暂保留上次已确认记录。';return false;}finally{if(refreshTask===task)refreshTask=null;}})();refreshTask=task;return task;
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
    renderExplanation(q,row);renderAnswerStats();await refreshRecords();
  }catch(e){if(epoch===authEpoch)message('feedback','答案保存未确认：'+errorText(e)+'。请重试确认，系统会防止重复。',true);}
  finally{if(epoch===authEpoch){busy=false;$('submit').disabled=done||selected===null;$('submit').textContent=done?'已保存':pending?'重试确认保存':'提交答案';updateFilters();}}
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
  timerState=null;timerTask=null;timerReady=false;timerChanging=false;
  correctionRecords=null;correctionLoad=null;
  $('studyCorrection').open=false;
  $('studyCorrectionRecord').replaceChildren();
  fillStudyCorrection();message('studyCorrectionStatus','');
  $('studyTimer').hidden=true;
  $('cloudTools').hidden=true;
  $('syncStatus').textContent='尚未同步。';
  message('restoreStatus','');
  renderStudyTimer();message('studyTimerStatus','');updateTimerButtons();
  $('password').value='';$('birthday').value='';$('examAt').value='';$('sourceFrame').removeAttribute('src');$('studyArea').hidden=true;$('profilePanel').hidden=true;$('logout').hidden=!user;$('authForm').hidden=!!user;$('authStatus').textContent=user?'已登录，检查本人访问权限…':'未登录 · 请使用本人的邮箱登录';
  $('explanation').replaceChildren();message('feedback','');message('authMessage','');renderLife();showClock();renderHeat();renderAnswerStats();
  if(!user)return;
  try{
    const {data:allowed,error:ownerError}=await cloud.rpc('is_study_owner');if(ownerError)throw ownerError;if(!allowed)throw Error('账号未被授权，或管理员尚未绑定唯一账号');
    if(epoch!==authEpoch)return;
    await loadProfile(epoch);
    const {data,error}=await cloud.from('study_questions').select(questionColumns).order('id',{ascending:true}).limit(200);if(error)throw error;if(epoch!==authEpoch)return;
    questions=(data||[]).filter(q=>q.id&&q.exam_year>=2024&&q.exam_year<=2026&&q.correct_options?.length&&/^https:\/\/www\.retio\.or\.jp\//.test(q.source_url));
    $('authStatus').textContent='已登录：'+user.email;$('studyArea').hidden=false;$('profilePanel').hidden=false;
    $('studyTimer').hidden=false;
    $('cloudTools').hidden=false;
    const timerLoad = refreshStudyTimer();
    const full=questions.filter(q=>q.explanation).length;$('bankStatus').textContent=`已核验官方答案 ${questions.length} 道 · 中文解析 ${full} 道 · 2026年待官方答案；无演示题。`;
    pending=loadPending();const pendingQ=questions.find(q=>q.id===pending?.question_id);
    if(pending&&!pendingQ){message('authMessage','本浏览器有未确认提交，但该题目不在已核验题库。请先核查旧记录，暂不继续答题。',true);$('submit').disabled=true;showQuestion(null);return;}
    if(pendingQ)showQuestion(pendingQ,pending.selected_option);else pickQuestion();
    await Promise.all([refreshRecords(),timerLoad]);resizeHeat();
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
$('logout').onclick=async()=>{if(!cloud||busy||restoreBusy||timerChanging)return;try{const {error}=await cloud.auth.signOut({scope:'local'});if(error)throw error;await applySession(null);}catch(e){message('authMessage','退出失败：'+errorText(e),true);}};
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
$('startStudy').onclick=()=>changeStudyTimer('start');
$('stopStudy').onclick=()=>changeStudyTimer('stop');
$('studyCorrection').ontoggle=()=>loadStudyCorrections();
$('studyCorrectionRecord').onchange=()=>{
  fillStudyCorrection();
  message('studyCorrectionStatus','');
};
$('studyCorrectionForm').onsubmit=saveStudyCorrection;
$('yearFilter').onchange=()=>{if(!busy&&!pending)pickQuestion();};$('categoryFilter').onchange=()=>{if(!busy&&!pending)pickQuestion();};
$('pdfPanel').ontoggle=()=>{if($('pdfPanel').open&&current)$('sourceFrame').src=$('sourceLink').href;};
$('heatYear').onchange=()=>renderHeat();$('lookupDay').onchange=()=>lookupDay();$('refresh').onclick=async()=>{if(user){const epoch=authEpoch;try{await loadProfile(epoch);}catch(e){message('profileMessage','读取时间设置失败：'+errorText(e),true);}await Promise.all([refreshRecords(),refreshStudyTimer()]);}};
$('retryCloud').onclick=startCloud;
$('export').onclick=async()=>{
  if(!user||restoreBusy)return;const epoch=authEpoch;$('export').disabled=true;
  try{
    const [answersLoaded,sessions]=await Promise.all([refreshRecords(),getAllRows('study_sessions',sessionColumns,epoch)]);
    if(!answersLoaded||epoch!==authEpoch)throw Error('未能取得完整云端记录，未生成备份');
    const backup={format:'takken-study',version:3,owner_id:user.id,exported_at:new Date().toISOString(),profile,answers:records.filter(x=>x.entry_kind!=='legacy'),legacy_answers:records.filter(x=>x.entry_kind==='legacy'),study_sessions:sessions};
    const url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`takken-study-backup-${jpDate()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);message('restoreStatus','备份已生成，包含答题、已结束的学习计时和私人设置。');
  }catch(e){message('restoreStatus',errorText(e),true);}finally{$('export').disabled=false;}
};
$('import').onclick=()=>{if(user&&!busy&&!restoreBusy&&!pending&&!timerChanging)$('importFile').click();else message('restoreStatus','请先完成当前操作，再恢复备份。',true);};
$('importFile').onchange=async()=>{
  const file=$('importFile').files[0];
  $('importFile').value='';
  if(!file||!user||busy||restoreBusy||pending||timerChanging)return;
  const epoch=authEpoch;
  restoreBusy=true;updateFilters();updateTimerButtons();$('import').disabled=true;$('export').disabled=true;$('logout').disabled=true;$('submit').disabled=true;
  const progress = [
    {label:'答题',rpc:'restore_study_answers',added:0,skipped:0},
    {label:'计时',rpc:'restore_study_sessions',added:0,skipped:0}
  ];
  const describeProgress = () => progress.map(item => `${item.label}新增 ${item.added} 条、跳过重复 ${item.skipped} 条`).join('。');
  try{
    if(file.size>20*1024*1024)throw Error('备份超过20MB上限');
    const backup=JSON.parse(await file.text());const rows=validateBackup(backup,user.id,new Set(questions.map(q=>q.id)));
    const sessions=validateStudySessions(backup);
    if(epoch!==authEpoch)throw Error('账号已切换，停止恢复');
    if(!confirm(`恢复 ${rows.length} 条答题记录和 ${sessions.length} 条学习计时？相同记录会跳过。`))return;
    for(const [recordsToRestore, result] of [[rows,progress[0]],[sessions,progress[1]]]){
      for(let i=0;i<recordsToRestore.length;i+=500){
        if(epoch!==authEpoch)throw Error('账号已切换，停止恢复');
        const {data,error}=await cloud.rpc(result.rpc,{p_rows:recordsToRestore.slice(i,i+500)});
        if(error)throw error;
        if(epoch!==authEpoch)throw Error('账号已切换，停止恢复');
        if(!data||!Number.isInteger(data.added)||!Number.isInteger(data.skipped))throw Error('未收到有效恢复结果');
        result.added+=data.added;result.skipped+=data.skipped;
        message('restoreStatus',`恢复中：${describeProgress()}。`);
      }
    }
    message('restoreStatus',`恢复完成：${describeProgress()}。`);
  }catch(e){if(epoch===authEpoch)message('restoreStatus',`恢复未完成：${errorText(e)}。已确认${describeProgress()}。可用同一备份重试，系统按ID去重。`,true);}
  finally{
    restoreBusy=false;$('import').disabled=false;$('export').disabled=false;$('logout').disabled=false;$('submit').disabled=done||selected===null;updateFilters();updateTimerButtons();
    if(user&&epoch===authEpoch)await Promise.all([refreshRecords(),refreshStudyTimer(),loadStudyCorrections($('studyCorrectionRecord').value)]);
  }
};
$('heatYear').append(new Option(jpDate().slice(0,4),jpDate().slice(0,4)));
if(typeof ResizeObserver!=='undefined')new ResizeObserver(resizeHeat).observe($('heat').parentElement);
window.addEventListener('resize',resizeHeat);
function updateClocks() {
  showClock();
  if (timerState) renderStudyTimer();
  const today = jpDate();
  if (today !== rememberedDay) {
    rememberedDay = today;
    renderLife();
    renderAnswerStats();
    if (!timerState) renderHeat();
  }
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)return;
  updateClocks();refreshStudyTimer();
  if(user&&Date.now()-lastRefresh>10000&&!restoreBusy)refreshRecords();
});
window.addEventListener('online',refreshStudyTimer);
setInterval(updateClocks,1000);
setInterval(()=>{if(user&&!document.hidden&&!restoreBusy){refreshRecords();refreshStudyTimer();}},30000);
renderLife();showClock();renderHeat();renderAnswerStats();startCloud();
