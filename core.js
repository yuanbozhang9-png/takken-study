export const DAY_MS = 86400000;
export const DEFAULT_EXAM = '2027-10-17T13:00:00+09:00';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const formatter = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
export function jpDate(now = new Date()) {
  const p = Object.fromEntries(formatter.formatToParts(now).map(x => [x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('日期格式不正确');
  const t = Date.parse(s+'T00:00:00Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0,10) !== s) throw new Error('日期不存在');
  return Math.round(t/DAY_MS);
}
export const dateFromDay = n => new Date(n*DAY_MS).toISOString().slice(0,10);
function birthdayAt(birthday, year) {
  // 闰日出生者在非闰年的年龄边界按 2/28 计算；本人的 9/4 不受此约定影响。
  let s = `${year}-${birthday.slice(5)}`;
  try {toDay(s);} catch {s = `${year}-02-28`;}
  return toDay(s);
}
export function lifeModel(birthday, today = jpDate()) {
  const first = toDay(birthday), year = Number(birthday.slice(0,4));
  if (year < 1900 || year > 2200) throw new Error('出生年份超出支持范围');
  const end = birthdayAt(birthday, year+30), current = toDay(today);
  const past = Math.min(end-first,Math.max(0,current-first));
  const remaining = end-first-past;
  return {past,remaining,total:end-first,rows:Array.from({length:30},(_,age) => ({age,start:birthdayAt(birthday,year+age),end:birthdayAt(birthday,year+age+1)})),current};
}
export function countdown(target, now = Date.now()) {
  const at=Date.parse(target);
  if (!Number.isFinite(at)) throw new Error('考试时间无效');
  const sec=Math.max(0,Math.floor((at-now)/1000));
  return [Math.floor(sec/86400),Math.floor(sec%86400/3600),Math.floor(sec%3600/60),sec%60];
}
export const heatLevel = n => n < 1 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n < 5 ? 3 : 4;
export function calendarCells(year) {
  const start=toDay(`${year}-01-01`),stop=toDay(`${year+1}-01-01`);
  const offset=new Date(start*DAY_MS).getUTCDay();
  const length=Math.ceil((offset+stop-start)/7)*7;
  return Array.from({length},(_,i) => i<offset || start+i-offset>=stop ? null : dateFromDay(start+i-offset));
}
export function dedupeRows(rows) {return [...new Map(rows.map(x=>[x.id,x])).values()];}
export function statistics(rows) {
  const counts=new Map();let correct=0;
  for (const row of dedupeRows(rows)) {
    if (row.entry_kind === 'legacy') continue;
    counts.set(row.studied_on,(counts.get(row.studied_on)||0)+1);
    if (row.is_correct) correct++;
  }
  const quantity=[...counts.values()].reduce((a,b)=>a+b,0);
  return {counts,days:counts.size,quantity,correct,accuracy:quantity?correct/quantity:null};
}
export function validateBackup(input, uid, knownQuestions, today = jpDate()) {
  if (!input || input.format !== 'takken-study' || ![2,3].includes(input.version)) throw new Error('仅支持本网页 v2 或 v3 导出的备份');
  if (input.owner_id !== uid) throw new Error('备份不属于当前登录账号');
  if (!Array.isArray(input.answers) || input.answers.length>50000) throw new Error('备份记录数量无效（上限50000）');
  const seen=new Map();
  for (const row of input.answers) {
    if (!row || !UUID.test(row.id) || !knownQuestions.has(row.question_id) || !Number.isInteger(row.selected_option) || row.selected_option<0 || row.selected_option>3) throw new Error('备份存在无效记录或尚未核验的题目');
    toDay(row.studied_on);
    if (row.studied_on>today || !Number.isFinite(Date.parse(row.created_at)) || jpDate(new Date(row.created_at)) !== row.studied_on) throw new Error('备份日期无效或与答题时间不一致');
    const clean={id:row.id.toLowerCase(),question_id:row.question_id,selected_option:row.selected_option,studied_on:row.studied_on,created_at:new Date(row.created_at).toISOString()};
    const old=seen.get(clean.id);
    if (old && JSON.stringify(old)!==JSON.stringify(clean)) throw new Error('备份中的同一记录ID存在冲突');
    seen.set(clean.id,clean);
  }
  return [...seen.values()];
}

export function formatStudyDuration(milliseconds) {
  const whole = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
}

export function studyPeriodStarts(timestamp) {
  const today = jpDate(new Date(timestamp));
  const day = toDay(today);
  const weekday = new Date(day * DAY_MS).getUTCDay();
  const japanOffset = 9 * 60 * 60 * 1000;
  return {
    month: toDay(today.slice(0, 7) + '-01') * DAY_MS - japanOffset,
    week: (day - (weekday + 6) % 7) * DAY_MS - japanOffset
  };
}

export function validateStudySessions(backup) {
  if (backup.version === 2) return [];
  if (!Array.isArray(backup.study_sessions) || backup.study_sessions.length > 50000) {
    throw new Error('学习计时备份数量无效（上限50000）');
  }
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  const seen = new Map();
  for (const row of backup.study_sessions) {
    if (!row || !UUID.test(row.id) || !timestamp.test(row.started_at) || !timestamp.test(row.ended_at)) {
      throw new Error('备份包含无效的学习计时记录');
    }
    toDay(row.started_at.slice(0, 10));
    toDay(row.ended_at.slice(0, 10));
    const start = Date.parse(row.started_at), end = Date.parse(row.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error('学习计时的开始或结束时间无效');
    }
    const clean = {id:row.id.toLowerCase(), started_at:new Date(start).toISOString(), ended_at:new Date(end).toISOString()};
    const previous = seen.get(clean.id);
    if (previous && (previous.started_at !== clean.started_at || previous.ended_at !== clean.ended_at)) {
      throw new Error('备份中的同一计时ID存在冲突');
    }
    seen.set(clean.id, clean);
  }
  return [...seen.values()];
}
export function randomQuestion(pool, previous, random = Math.random) {
  const choices=pool.length>1?pool.filter(x=>x.id!==previous):pool;
  return choices.length?choices[Math.floor(random()*choices.length)]:null;
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('浏览器缺少安全随机数支持，请使用新版浏览器与HTTPS');
  const b=globalThis.crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
