const APP_VERSION = '0.1.0';
const DEFAULT_WORD_BATCH_SIZE = 24;
const DEFAULT_WORD_ORDER_SEED = 20260921;
const WORD_ORDER_VERSION = 2;
const RESOURCE_PAGE_SIZE = 60;
const RECOVERABLE_STATE_PREFIX = 'cet6-recoverable-state:';
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const TASK_KEYS = ['reading', 'listening', 'writingTranslation'];
const TASK_LABELS = { reading: '阅读', listening: '听力', writingTranslation: '写译' };
const TASK_MINUTES = { reading: 25, listening: 35, writingTranslation: 30 };
const DEFAULT_TASK_TARGETS_BY_DAY = {
  0: { reading: 0, listening: 0, writingTranslation: 0 },
  1: { reading: 1, listening: 1, writingTranslation: 0 },
  2: { reading: 1, listening: 1, writingTranslation: 0 },
  3: { reading: 1, listening: 1, writingTranslation: 0 },
  4: { reading: 1, listening: 1, writingTranslation: 0 },
  5: { reading: 1, listening: 1, writingTranslation: 0 },
  6: { reading: 0, listening: 0, writingTranslation: 0 }
};
const VIEW_NAMES = {
  home: '今日 / 学习概览',
  planner: '学习日历 / 自动规划',
  words: '单词复习 / 间隔复习',
  simulation: '整套模拟 / 考试流程',
  reports: '学习报告 / 实际记录',
  resources: '学习资料'
};

const main = document.querySelector('#main-content');
const breadcrumb = document.querySelector('#breadcrumb');
const sidebar = document.querySelector('#sidebar');
const saveStatuses = [...document.querySelectorAll('#save-status, #topbar-save-status')];
const backupDialog = document.querySelector('#backup-dialog');
const toastRegion = document.querySelector('#toast-region');

const authScreen = document.querySelector('#auth-screen');
const appShell = document.querySelector('#app-shell');
const authLoading = document.querySelector('#auth-loading');
const authForm = document.querySelector('#auth-form');
const authError = document.querySelector('#auth-error');
const authSubmit = document.querySelector('#auth-submit');
const authToggle = document.querySelector('#auth-toggle');
const authSwitchCopy = document.querySelector('#auth-switch-copy');
const authUsernameInput = document.querySelector('#auth-username');
const authPasswordInput = document.querySelector('#auth-password');
const userNameLabel = document.querySelector('#user-name');
const userAvatarLabel = document.querySelector('#user-avatar');
const logoutButton = document.querySelector('#logout-button');

let content = { version: 'empty', words: [], wordBatchSize: DEFAULT_WORD_BATCH_SIZE, practice: [], grammarUnits: [], demoSimulation: null, realExams: [], mockExams: [] };
const examDetails = new Map();
const examDetailLoads = new Map();
let catalog = { totalFiles: 0, totalBytes: 0, items: [], summary: {}, sourceAvailable: false };
let state = createDefaultState();
let stateReady = false;
let saveQueue = Promise.resolve();
let realTextSaveTimer;
let searchCompositionActive = false;
let activeView = 'home';
let viewState = {
  wordIndex: 0,
  wordShow: false,
  wordFilter: '',
  practiceType: '全部',
  practiceIndex: 0,
  practiceSelections: {},
  writingDrafts: {},
  grammarId: '',
  planDraft: null,
  planPreview: null,
  resourceSearch: '',
  resourceTopic: '全部',
  resourceKind: '全部',
  resourcePage: 0,
  sidebarOpen: false,
  examTimer: null,
  realExamId: null,
  realExamMode: 'full',
  realSessionKey: '',
  realUnitId: '',
  realFocusId: '',
  realExamSection: '全部'
};

function createDefaultState() {
  const startDate = todayKey();
  return {
    version: 1,
    appVersion: APP_VERSION,
    settings: {
      startDate,
      endDate: addDays(startDate, 42),
      studyWeekdays: [1, 2, 3, 4, 5],
      minutesByDay: { 0: 0, 1: 45, 2: 45, 3: 45, 4: 45, 5: 45, 6: 60 },
      tasksByDay: cloneTaskTargetsByDay(),
      specialDates: {},
      mode: 'time',
      targets: { vocabularyCoverage: 80, simulationCount: 1 },
      base: { knownWords: 0 },
      focus: ['阅读', '听力'],
      bufferPercent: 15,
      examDate: ''
    },
    plan: null,
    planHistory: [],
    wordBatch: 0,
    wordOrderSeed: DEFAULT_WORD_ORDER_SEED,
    wordOrderVersion: WORD_ORDER_VERSION,
    wordProgress: {},
    practiceResults: {},
    grammarDone: {},
    notes: {},
    activity: [],
    examSession: null,
    realExamSessions: {},
    lastExamResult: null,
    importedAt: null,
    lastView: 'home',
    dataRevision: 0,
    dataUpdatedAt: null
  };
}

function todayKey() {
  const now = new Date();
  return dateKey(now);
}

function parseDate(key) {
  return new Date(`${key}T00:00:00`);
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(key, amount) {
  const date = parseDate(key);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

function inclusiveDays(startKey, endKey) {
  const start = parseDate(startKey);
  const end = parseDate(endKey);
  return Math.floor((end - start) / 86400000) + 1;
}

function formatDate(key, withWeekday = true) {
  if (!key) return '未设置';
  const date = parseDate(key);
  const base = `${date.getMonth() + 1}月${date.getDate()}日`;
  return withWeekday ? `${base} 周${DAY_NAMES[date.getDay()]}` : base;
}

function formatDateRange(start, end) {
  if (!start || !end) return '尚未设置学习周期';
  return `${formatDate(start, false)} — ${formatDate(end, false)}`;
}

function formatMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function formatHours(minutes) {
  return `${(Math.max(0, minutes) / 60).toFixed(1)} 小时`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function getJSON(url, fallback) {
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.ok ? response.json() : fallback).catch(() => fallback);
}

async function getRequiredJSON(url, label) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new Error(`${label}加载失败，请确认网站服务仍在运行。`);
  }
  if (!response.ok) {
    throw new Error(`${label}加载失败（HTTP ${response.status}）。`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}数据格式损坏，未继续打开空白页面。`);
  }
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

function markSaving(label = '正在保存…') {
  saveStatuses.forEach((node) => { node.textContent = label; });
  document.querySelectorAll('.status-dot').forEach((dot) => {
    dot.classList.add('status-dot-saving');
    dot.classList.remove('status-dot-error');
  });
}

function markSaved() {
  saveStatuses.forEach((node) => { node.textContent = '已保存'; });
  document.querySelectorAll('.status-dot').forEach((dot) => {
    dot.classList.remove('status-dot-saving', 'status-dot-error');
  });
}

function markSaveError() {
  saveStatuses.forEach((node) => { node.textContent = '保存失败'; });
  document.querySelectorAll('.status-dot').forEach((dot) => {
    dot.classList.remove('status-dot-saving');
    dot.classList.add('status-dot-error');
  });
}

async function loadState() {
  const response = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 401) throw new Error('登录状态已失效，请重新登录。');
    throw new Error('账户数据暂时无法读取，请确认服务正在运行。');
  }
  const payload = await response.json();
  stateReady = true;
  return payload.state ? hydrateState(payload.state) : createDefaultState();
}

function normalizeRealExamSessions(input = {}) {
  const sessions = {};
  for (const [storageKey, rawSession] of Object.entries(input || {})) {
    if (!rawSession || typeof rawSession !== 'object') continue;
    const parts = storageKey.split('::');
    const modes = ['full', 'reading', 'listening', 'writingTranslation'];
    const examId = rawSession.examId || (modes.includes(parts[1]) ? parts[0] : storageKey);
    const mode = modes.includes(parts[1]) ? parts[1] : (modes.includes(rawSession.mode) ? rawSession.mode : 'full');
    const scope = parts[0] === examId && parts[1] === mode && parts.length > 2 ? `::${parts.slice(2).join('::')}` : '';
    const key = `${examId}::${mode}${scope}`;
    const prior = sessions[key] || {};
    sessions[key] = {
      ...rawSession,
      ...prior,
      examId,
      mode,
      answers: { ...(rawSession.answers || {}), ...(prior.answers || {}) },
      textAnswers: { ...(rawSession.textAnswers || {}), ...(prior.textAnswers || {}) }
    };
  }
  return sessions;
}

function hydrateState(saved) {
  const defaults = createDefaultState();
  const tasksByDay = saved.settings?.tasksByDay
    ? cloneTaskTargetsByDay(saved.settings.tasksByDay)
    : taskTargetsFromMinutes(saved.settings?.minutesByDay || defaults.settings.minutesByDay);
  return {
    ...defaults,
    ...saved,
    settings: {
      ...defaults.settings,
      ...(saved.settings || {}),
      targets: { ...defaults.settings.targets, ...(saved.settings?.targets || {}) },
      base: { ...defaults.settings.base, ...(saved.settings?.base || {}) },
      minutesByDay: { ...defaults.settings.minutesByDay, ...(saved.settings?.minutesByDay || {}) },
      tasksByDay,
      specialDates: { ...(saved.settings?.specialDates || {}) }
    },
    wordProgress: { ...(saved.wordProgress || {}) },
    wordBatch: Math.max(0, Number(saved.wordBatch || 0)),
    wordOrderSeed: Number.isFinite(Number(saved.wordOrderSeed)) ? Number(saved.wordOrderSeed) : DEFAULT_WORD_ORDER_SEED,
    wordOrderVersion: Number.isFinite(Number(saved.wordOrderVersion)) ? Number(saved.wordOrderVersion) : 0,
    practiceResults: { ...(saved.practiceResults || {}) },
    grammarDone: { ...(saved.grammarDone || {}) },
    notes: { ...(saved.notes || {}) },
    activity: Array.isArray(saved.activity) ? saved.activity : [],
    planHistory: Array.isArray(saved.planHistory) ? saved.planHistory : [],
    examSession: saved.examSession || null,
    realExamSessions: normalizeRealExamSessions(saved.realExamSessions),
    lastExamResult: saved.lastExamResult || null,
    dataRevision: Number.isFinite(Number(saved.dataRevision)) ? Number(saved.dataRevision) : 0,
    dataUpdatedAt: saved.dataUpdatedAt || null
  };
}

function recoverableStateKey(username = '') {
  const account = String(username || userNameLabel.textContent || 'local').trim().toLowerCase();
  return RECOVERABLE_STATE_PREFIX + encodeURIComponent(account);
}

function rememberRecoverableState(snapshot, reason = '待同步') {
  try {
    window.localStorage.setItem(recoverableStateKey(), JSON.stringify({
      savedAt: Date.now(),
      reason,
      state: JSON.parse(snapshot)
    }));
    return true;
  } catch {
    return false;
  }
}

function readRecoverableState(username = '') {
  try {
    const saved = window.localStorage.getItem(recoverableStateKey(username));
    const parsed = saved ? JSON.parse(saved) : null;
    return parsed?.state && typeof parsed.state === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function clearRecoverableState(username = '') {
  try { window.localStorage.removeItem(recoverableStateKey(username)); } catch { /* Browser storage may be unavailable. */ }
}

function statesAreEquivalent(left, right) {
  try {
    const normalize = (value) => {
      const result = hydrateState(value);
      result.dataRevision = 0;
      result.dataUpdatedAt = null;
      return JSON.stringify(result);
    };
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}

function recoverLocalState(username) {
  const pending = readRecoverableState(username);
  if (!pending) return { pending: false, restored: false };
  if (statesAreEquivalent(pending.state, state)) {
    clearRecoverableState(username);
    return { pending: false, restored: false };
  }
  const savedAt = new Date(Number(pending.savedAt || 0)).toLocaleString('zh-CN');
  const restore = window.confirm(`发现 ${savedAt} 保存到本机的未同步学习草稿。恢复草稿会用它替换当前账号的服务器记录，是否恢复？`);
  if (!restore) return { pending: true, restored: false };
  const latestRevision = Number(state.dataRevision || 0);
  state = hydrateState(pending.state);
  state.dataRevision = latestRevision;
  state.dataUpdatedAt = null;
  stateReady = true;
  return { pending: true, restored: true };
}

function saveState(message = '已保存') {
  if (!stateReady) return Promise.resolve(false);
  state.appVersion = APP_VERSION;
  rememberRecoverableState(JSON.stringify(state));
  saveQueue = saveQueue.then(async () => {
    markSaving();
    try {
      // 在队列真正执行时取最新状态，避免连续点击造成旧快照覆盖新快照。
      const snapshot = JSON.stringify(state);
      rememberRecoverableState(snapshot);
      const response = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: snapshot,
        keepalive: new TextEncoder().encode(snapshot).byteLength <= 60000
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.state) {
        rememberRecoverableState(snapshot, '账户在其他页面更新时发生冲突');
        throw new Error('账户数据已在其他页面更新；当前页面的更改仍保留在本机草稿中，没有被覆盖。刷新后可选择恢复草稿。');
      }
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'state save failed');
      if (Number.isFinite(Number(payload.revision))) state.dataRevision = Number(payload.revision);
      state.dataUpdatedAt = new Date().toISOString();
      if (statesAreEquivalent(JSON.parse(snapshot), state)) clearRecoverableState();
      markSaved();
      if (message) showToast(message, 'success');
      return true;
    } catch (error) {
      markSaveError();
      const pending = readRecoverableState();
      const backupAvailable = pending && statesAreEquivalent(pending.state, state);
      const messageText = error.message || '保存失败，当前更改尚未写入账户数据。';
      showToast(backupAvailable ? `${messageText} 草稿已暂存在本机。` : `${messageText} 本机暂存失败；请先使用“导出学习数据”。`, 'warn');
      return false;
    }
  });
  return saveQueue;
}

function recordActivity(label, minutes = 0, type = '学习') {
  const key = todayKey();
  state.activity = [{ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, date: key, label, minutes, type }, ...state.activity].slice(0, 80);
}

function normalizeTaskTargets(value = {}) {
  return TASK_KEYS.reduce((targets, key) => {
    targets[key] = Math.max(0, Math.min(20, Math.floor(Number(value?.[key]) || 0)));
    return targets;
  }, {});
}

function cloneTaskTargetsByDay(source = DEFAULT_TASK_TARGETS_BY_DAY) {
  return Object.fromEntries(DAY_NAMES.map((_, day) => [day, normalizeTaskTargets(source?.[day] || {})]));
}

function taskTargetsFromMinutes(minutesByDay = {}) {
  return Object.fromEntries(DAY_NAMES.map((_, day) => {
    const minutes = Math.max(0, Number(minutesByDay?.[day] || 0));
    return [day, normalizeTaskTargets({
      reading: minutes >= TASK_MINUTES.reading ? 1 : 0,
      listening: minutes >= TASK_MINUTES.reading + TASK_MINUTES.listening ? 1 : 0,
      writingTranslation: minutes >= TASK_MINUTES.reading + TASK_MINUTES.listening + TASK_MINUTES.writingTranslation ? 1 : 0
    })];
  }));
}

function totalTaskUnits(targets = {}) {
  return TASK_KEYS.reduce((sum, key) => sum + Number(targets?.[key] || 0), 0);
}

function estimateTaskMinutes(targets = {}) {
  return TASK_KEYS.reduce((sum, key) => sum + Number(targets?.[key] || 0) * TASK_MINUTES[key], 0);
}

function estimateListeningUnitMinutes(unit) {
  const audioMinutes = Number.isFinite(Number(unit.audioDurationSeconds)) && Number(unit.audioDurationSeconds) > 0
    ? Math.ceil(Number(unit.audioDurationSeconds) / 60)
    : 0;
  const questionReviewMinutes = Math.ceil(Math.max(0, Number(unit.questionCount || 0)) * 0.2);
  return Math.max(TASK_MINUTES.listening, audioMinutes + 2 + questionReviewMinutes);
}

function formatTaskSummary(targets = {}) {
  const items = TASK_KEYS
    .filter((key) => Number(targets?.[key] || 0) > 0)
    .map((key) => `${TASK_LABELS[key]} ${Number(targets[key])} 篇`);
  return items.join(' · ') || '不安排必做任务';
}

function taskTargetsForSpecialDate(special, fallback, weekday) {
  if (special?.tasks) return normalizeTaskTargets(special.tasks);
  if (['extra', 'custom'].includes(special?.type) && Number(special.minutes || 0) > 0) {
    return taskTargetsFromMinutes({ [weekday]: special.minutes })[weekday];
  }
  return normalizeTaskTargets(fallback);
}

function getCalendar(settings) {
  const result = { days: [], active: [], error: '' };
  if (!settings.startDate || !settings.endDate) {
    result.error = '请选择开始日期和结束日期。';
    return result;
  }
  const total = inclusiveDays(settings.startDate, settings.endDate);
  if (total < 1) {
    result.error = '结束日期不能早于开始日期。';
    return result;
  }
  if (total > 1825) {
    result.error = '学习日期范围不能超过五年。';
    return result;
  }
  const weekdays = new Set((settings.studyWeekdays || []).map(Number));
  for (let index = 0; index < total; index += 1) {
    const key = addDays(settings.startDate, index);
    const date = parseDate(key);
    const weekday = date.getDay();
    const special = settings.specialDates?.[key] || null;
    const defaultTasks = normalizeTaskTargets(settings.tasksByDay?.[weekday]);
    let active = weekdays.has(weekday);
    let taskTargets = active ? defaultTasks : normalizeTaskTargets();
    let reason = active ? '每周规律' : '未选择为学习日';
    let override = '';
    if (special?.type === 'rest') {
      active = false;
      taskTargets = normalizeTaskTargets();
      reason = special.note || '特殊休息日';
      override = '休息日';
    } else if (special?.type === 'extra') {
      active = true;
      taskTargets = taskTargetsForSpecialDate(special, defaultTasks, weekday);
      reason = special.note || '额外学习日';
      override = '额外学习';
    } else if (special?.type === 'custom') {
      taskTargets = taskTargetsForSpecialDate(special, normalizeTaskTargets(), weekday);
      active = totalTaskUnits(taskTargets) > 0;
      reason = special.note || '单日调整';
      override = '单日调整';
    }
    if (active && totalTaskUnits(taskTargets) <= 0) {
      active = false;
      reason = '当天没有安排任务';
    }
    const minutes = estimateTaskMinutes(taskTargets);
    const day = { key, weekday, active, minutes, estimatedMinutes: minutes, taskTargets, reason, override, special };
    result.days.push(day);
    if (active) result.active.push(day);
  }
  if (!result.active.length) result.error = '当前设置没有有效学习日，请选择星期或增加特殊学习日。';
  return result;
}

function getContentUnits() {
  return allExams().flatMap((exam) => [
    ...(exam.readingUnits || []).map((unit) => ({ ...unit, kind: 'reading' })),
    ...(exam.listeningUnits || []).map((unit) => ({ ...unit, kind: 'listening' })),
    ...(exam.writingTranslationUnits || []).map((unit) => ({ ...unit, kind: 'writingTranslation' }))
  ]);
}

function getContentStats() {
  const exams = allExams();
  const units = getContentUnits();
  return {
    words: content.words.length,
    simulations: exams.filter((exam) => exam.fullAvailable === true).length,
    openFullPractices: exams.filter((exam) => exam.fullPracticeEnabled === true).length,
    readingTasks: units.filter((unit) => unit.kind === 'reading').length,
    listeningTasks: units.filter((unit) => unit.kind === 'listening').length,
    writingTranslationTasks: units.filter((unit) => unit.kind === 'writingTranslation').length
  };
}

function sessionCompletesPlanUnit(task, session) {
  if (!session || !session.submittedAt || session.examId !== task.examId) return false;
  if (session.mode !== task.mode && session.mode !== 'full') return false;
  if (task.kind === 'writingTranslation') return String(session.textAnswers?.[task.taskId] || '').trim().length >= 20;
  const questionIds = task.questionIds || [];
  return questionIds.length > 0 && questionIds.every((id) => {
    const answer = session.answers?.[id];
    return answer !== undefined && answer !== null && String(answer).trim() !== '';
  });
}

function planUnitHasSubmittedWork(task) {
  return Object.values(state.realExamSessions || {}).some((session) => sessionCompletesPlanUnit(task, session));
}

function buildPlan(settings) {
  const calendar = getCalendar(settings);
  if (calendar.error) return { version: 2, settingsSnapshot: structuredClone(settings), calendar, error: calendar.error, days: [], calculations: null };

  const futureActive = calendar.active.filter((day) => day.key >= todayKey());
  const planningDays = futureActive.length ? futureActive : calendar.active;
  const requestedTaskTotals = Object.fromEntries(TASK_KEYS.map((key) => [key, 0]));
  const actualTaskTotals = Object.fromEntries(TASK_KEYS.map((key) => [key, 0]));
  const allUnits = getContentUnits();
  const completedIds = new Set(state.plan?.completedIds || []);
  for (const unit of allUnits) {
    const task = { ...unit, id: `${unit.kind}:${unit.id}` };
    if (planUnitHasSubmittedWork(task)) completedIds.add(task.id);
  }
  const knownTaskIds = new Set(allUnits.map((unit) => `${unit.kind}:${unit.id}`));
  const availableUnits = Object.fromEntries(TASK_KEYS.map((key) => [
    key,
    allUnits.filter((unit) => unit.kind === key && !completedIds.has(`${key}:${unit.id}`))
  ]));
  const unitCursor = Object.fromEntries(TASK_KEYS.map((key) => [key, 0]));
  const daily = planningDays.map((day) => ({ ...day, tasks: [], scheduledTaskTargets: normalizeTaskTargets() }));
  for (const day of daily) {
    for (const key of TASK_KEYS) {
      const requested = Number(day.taskTargets?.[key] || 0);
      requestedTaskTotals[key] += requested;
      const available = availableUnits[key] || [];
      const count = Math.min(requested, Math.max(0, available.length - unitCursor[key]));
      day.scheduledTaskTargets[key] = count;
      if (count <= 0) continue;
      for (const unit of available.slice(unitCursor[key], unitCursor[key] + count)) {
        day.tasks.push({
          id: `${key}:${unit.id}`,
          kind: key,
          unitId: unit.id,
          examId: unit.examId,
          mode: unit.mode,
          focusId: unit.focusId,
          questionIds: unit.questionIds || [],
          taskId: unit.taskId || '',
          label: `${TASK_LABELS[key]} · ${unit.label}`,
          minutes: key === 'listening' ? estimateListeningUnitMinutes(unit) : Number(unit.minutes || TASK_MINUTES[key]),
          count: 1,
          detail: unit.questionCount ? `${unit.questionCount} 道题 · 完成材料与解析复盘后再标记完成。` : '完成这份材料并复盘后再标记完成。'
        });
      }
      unitCursor[key] += count;
      actualTaskTotals[key] += count;
    }
  }

  const completedUnits = allUnits.filter((unit) => completedIds.has(`${unit.kind}:${unit.id}`));
  for (const unit of completedUnits) actualTaskTotals[unit.kind] += 1;
  const taskGaps = Object.fromEntries(TASK_KEYS.map((key) => [key, Math.max(0, requestedTaskTotals[key] - actualTaskTotals[key])]));
  const requestedTaskUnits = totalTaskUnits(requestedTaskTotals);
  const totalTaskUnitsPlanned = totalTaskUnits(actualTaskTotals);
  const tasks = daily.flatMap((day) => day.tasks);
  const requiredMinutes = estimateTaskMinutes(requestedTaskTotals);
  const expectedMinutes = tasks.reduce((sum, task) => sum + Number(task.minutes || 0), 0);
  const currentTaskIds = new Set(tasks.map((task) => task.id));
  const legacyCompletedTaskCount = [...completedIds].filter((id) => !knownTaskIds.has(id) && !currentTaskIds.has(id)).length;
  const completedMinutes = completedUnits.reduce((sum, unit) => sum + (unit.kind === 'listening'
    ? estimateListeningUnitMinutes(unit)
    : Number(unit.minutes || TASK_MINUTES[unit.kind] || 0)), 0);
  const completedTaskUnits = completedUnits.length;
  const minutesByDay = new Map(daily.map((day) => [day.key, day.tasks.reduce((sum, task) => sum + Number(task.minutes || 0), 0)]));
  const calendarDays = calendar.days.map((day) => {
    const minutes = minutesByDay.get(day.key) ?? 0;
    return { ...day, minutes, estimatedMinutes: minutes };
  });
  const firstDate = daily[0]?.key || settings.endDate;
  const lastDate = daily.at(-1)?.key || settings.endDate;
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    settingsSnapshot: structuredClone(settings),
    calendar: { ...calendar, days: calendarDays },
    mode: 'tasks',
    error: '',
    days: daily,
    completedIds: [...completedIds],
    calculations: {
      availableMinutes: null,
      usableMinutes: null,
      requiredMinutes,
      expectedMinutes,
      gapMinutes: 0,
      activeDays: planningDays.length,
      taskTargetTotals: requestedTaskTotals,
      taskActualTotals: actualTaskTotals,
      taskGaps,
      requestedTaskUnits,
      totalTaskUnits: totalTaskUnitsPlanned,
      contentCapacity: {
        reading: availableUnits.reading.length,
        listening: availableUnits.listening.length,
        writingTranslation: availableUnits.writingTranslation.length
      },
      targetWords: 0,
      targetMocks: 0,
      actualWords: 0,
      actualMocks: 0,
      dueWords: 0,
      completedMinutes,
      completedTaskUnits,
      legacyCompletedTaskCount,
      feasible: TASK_KEYS.every((key) => taskGaps[key] === 0),
      projectedEnd: lastDate,
      firstDate
    }
  };
}

function getDisplayedPlan() {
  if (viewState.planPreview) return viewState.planPreview;
  if (state.plan?.version >= 2) return state.plan;
  return buildPlan(state.settings);
}

function refreshPlanFromRecords() {
  const rebuilt = buildPlan(state.settings);
  if (!rebuilt.error) state.plan = rebuilt;
  return rebuilt;
}

function planCompletion(plan) {
  if (plan?.calculations?.totalTaskUnits) {
    return Math.min(100, Math.round((plan.calculations.completedTaskUnits / plan.calculations.totalTaskUnits) * 100));
  }
  if (!plan?.calculations?.expectedMinutes) return 0;
  return Math.min(100, Math.round((plan.calculations.completedMinutes / plan.calculations.expectedMinutes) * 100));
}

function getTodayPlanDay(plan) {
  const today = todayKey();
  return plan?.days?.find((day) => day.key === today) || plan?.days?.find((day) => day.key >= today) || plan?.days?.[0] || null;
}

function getWordProgress(wordId) {
  const saved = state.wordProgress[wordId] || {};
  return {
    stage: 0,
    nextReview: todayKey(),
    seenCount: 0,
    lastRating: null,
    favorite: false,
    mastered: false,
    ...saved,
    mastered: Boolean(saved.mastered || Number(saved.stage || 0) >= 4)
  };
}

function wordStatus(progress) {
  if (!progress.seenCount) return { label: '待学习', className: 'pill' };
  if (progress.mastered) return { label: '已背会', className: 'pill pill-green' };
  if (progress.nextReview && progress.nextReview <= todayKey()) return { label: '可再次出现', className: 'pill pill-coral' };
  return { label: '学习中', className: 'pill pill-blue' };
}

function getWordStats() {
  const all = content.words;
  const stable = all.filter((word) => getWordProgress(word.id).mastered).length;
  const seen = all.filter((word) => getWordProgress(word.id).seenCount > 0).length;
  const due = all.filter((word) => {
    const progress = getWordProgress(word.id);
    return progress.seenCount > 0 && !progress.mastered && (!progress.nextReview || progress.nextReview <= todayKey());
  }).length;
  return { total: all.length, stable, seen, due, coverage: all.length ? Math.round((seen / all.length) * 100) : 0, stableRate: all.length ? Math.round((stable / all.length) * 100) : 0 };
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

function shuffleWords(words, seed) {
  const shuffled = [...words];
  let random = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const target = random % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function getShuffledWordCatalog() {
  return shuffleWords(content.words || [], hashSeed(`${state.wordOrderSeed}:catalog:${WORD_ORDER_VERSION}`));
}

function getCurrentWordBatchWords() {
  if (state.wordOrderVersion !== WORD_ORDER_VERSION) {
    state.wordOrderVersion = WORD_ORDER_VERSION;
    state.wordBatch = 0;
    if (stateReady) {
      saveState('词汇顺序已更新');
      showToast('词汇已重新打乱，已掌握记录保留', 'success');
    }
  }
  const all = getShuffledWordCatalog();
  if (!all.length) return [];
  const size = Math.max(1, Number(content.wordBatchSize || DEFAULT_WORD_BATCH_SIZE));
  const lastBatch = Math.max(0, Math.ceil(all.length / size) - 1);
  const previousBatch = Math.max(0, Math.min(lastBatch, Number(state.wordBatch || 0)));
  let batch = previousBatch;
  while (batch < lastBatch) {
    const current = all.slice(batch * size, (batch + 1) * size);
    if (!current.length || !current.every((word) => getWordProgress(word.id).mastered)) break;
    batch += 1;
  }
  if (batch !== previousBatch) {
    state.wordBatch = batch;
    if (stateReady) {
      saveState(`已进入第 ${batch + 1} 批词汇`);
      showToast(`第 ${batch + 1} 批词汇已加载`, 'success');
    }
  }
  return all.slice(batch * size, (batch + 1) * size);
}

function getPracticeStats() {
  const results = Object.values(state.practiceResults);
  const completed = results.filter((result) => result.completed).length;
  const correct = results.filter((result) => result.correct).length;
  return { completed, correct, accuracy: completed ? Math.round((correct / completed) * 100) : 0 };
}

function getDayMinutes(dayKey) {
  return state.activity.filter((item) => item.date === dayKey).reduce((sum, item) => sum + Number(item.minutes || 0), 0);
}

function setView(view) {
  // Navigation from an open real-paper workspace must return to the module
  // catalog instead of leaving the previous paper mounted over the new view.
  // The saved answers remain in the local session; only the active screen is
  // cleared here.
  if (viewState.realExamId) {
    viewState.realExamId = null;
    if (viewState.examTimer) window.clearInterval(viewState.examTimer);
    viewState.examTimer = null;
  }
  viewState.realExamMode = 'full';
  activeView = VIEW_NAMES[view] ? view : 'home';
  state.lastView = activeView;
  viewState.sidebarOpen = false;
  breadcrumb.textContent = VIEW_NAMES[activeView];
  sidebar.classList.remove('open');
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === activeView));
  render();
}

function render() {
  breadcrumb.textContent = VIEW_NAMES[activeView];
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === activeView));
  const renderer = {
    home: renderHome,
    planner: renderPlanner,
    words: renderWords,
    simulation: renderSimulation,
    reports: renderReports,
    resources: renderResources
  }[activeView] || renderHome;
  main.innerHTML = renderer();
  if (activeView === 'simulation' && state.examSession) startExamTimerLoop();
  if (activeView === 'simulation' && viewState.realExamId) startRealExamTimerLoop();
}

function rerenderSearchPreservingFocus(input) {
  const inputId = input.id;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  render();
  const replacement = document.getElementById(inputId);
  if (!replacement) return;
  replacement.focus({ preventScroll: true });
  if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
    replacement.setSelectionRange(selectionStart, selectionEnd);
  }
  window.scrollTo(scrollX, scrollY);
}

function renderHome() {
  const plan = getDisplayedPlan();
  const today = getTodayPlanDay(plan);
  const words = getWordStats();
  const planStats = plan.calculations;
  const endDate = state.settings.endDate;
  const daysLeft = endDate && endDate >= todayKey() ? inclusiveDays(todayKey(), endDate) : 0;
  const todayTasks = today?.tasks || [];
  const todayView = todayTasks.some((task) => ['reading', 'listening', 'writingTranslation'].includes(task.kind)) ? 'simulation' : 'words';
  return `
    <div class="page-heading">
      <div>
        <div class="eyebrow">今日概览 · ${escapeHTML(formatDate(todayKey()))}</div>
        <h1>今天，从一个可完成的动作开始。</h1>
        <p>计划按你为每个学习日设置的阅读、听力和写译篇数生成。预计用时只作参考，不替你决定每天学什么。</p>
      </div>
      <div class="heading-meta"><span class="date-stamp">${escapeHTML(formatDateRange(state.settings.startDate, state.settings.endDate))}</span><span>${daysLeft ? `还剩 ${daysLeft} 个日历日` : '尚未设置有效截止日期'}</span></div>
    </div>
    <section class="hero-grid">
      <div class="hero-card">
        <div class="eyebrow">今日重点</div>
        <h1>${todayTasks.length ? escapeHTML(todayTasks[0].label) : '先把个人学习日历设好'}</h1>
        <p>${todayTasks.length ? escapeHTML(todayTasks[0].detail) : '选择日期范围、每周学习日和每天要完成的阅读、听力、写译篇数，系统会把它们排进日历。'}</p>
        <div class="hero-actions">
          ${todayTasks[0]?.examId ? `<button class="button button-primary" data-action="start-planned-unit" data-exam-id="${escapeHTML(todayTasks[0].examId)}" data-exam-mode="${escapeHTML(todayTasks[0].mode || 'full')}" data-focus-id="${escapeHTML(todayTasks[0].focusId || '')}" data-unit-id="${escapeHTML(todayTasks[0].unitId || '')}">开始今日任务 <span aria-hidden="true">→</span></button>` : `<button class="button button-primary" data-view="${todayTasks.length ? todayView : 'planner'}">${todayTasks.length ? '开始今日任务' : '打开规划向导'} <span aria-hidden="true">→</span></button>`}
          <button class="button button-secondary" data-view="planner">查看日历</button>
        </div>
      </div>
      <div class="card plan-snapshot">
        <div class="snapshot-label"><span>当前计划</span><span class="pill ${planStats?.feasible ? 'pill-green' : 'pill-coral'}">${planStats?.feasible ? '可按当前设置完成' : '需要调整'}</span></div>
        <div class="snapshot-main"><div class="number">${planStats ? `${planStats.totalTaskUnits} 篇` : '—'}</div><div class="subline">当前计划总任务 · 预计 ${formatMinutes(planStats?.expectedMinutes || 0)}</div></div>
        <div><div class="progress-bar"><div class="progress-fill" style="width:${planCompletion(plan)}%"></div></div><div class="snapshot-footer"><span>已完成 ${planStats?.completedTaskUnits || 0} / ${planStats?.totalTaskUnits || 0} 篇</span><span>${planCompletion(plan)}%</span></div></div>
      </div>
    </section>
    <section class="metrics-grid">
      <div class="metric-card"><div class="metric-top"><span class="metric-label">词汇覆盖</span><span class="metric-icon">Aa</span></div><div class="number">${words.coverage}%</div><div class="metric-detail">已接触 ${words.seen} / ${words.total} 条样本</div></div>
      <div class="metric-card"><div class="metric-top"><span class="metric-label">已标记背会</span><span class="metric-icon">✓</span></div><div class="number">${words.stableRate}%</div><div class="metric-detail">按你点击“已背会”的词条计数</div></div>
      <div class="metric-card"><div class="metric-top"><span class="metric-label">到期复习</span><span class="metric-icon">↻</span></div><div class="number">${words.due}</div><div class="metric-detail">优先于新词学习</div></div>
    </section>
    <section class="section-grid">
      <div class="card card-pad">
        <div class="card-header"><div><div class="eyebrow">今日任务</div><h2>今天的任务</h2></div><span class="card-note">${today ? escapeHTML(formatDate(today.key)) : '无可用学习日'}</span></div>
        ${todayTasks.length ? `<div class="task-list">${todayTasks.map((task) => renderTaskRow(task, plan)).join('')}</div>` : `<div class="empty-state"><strong>今天没有安排必做任务</strong><span>休息日不会被偷偷塞入任务；需要调整时，去学习日历预览计划。</span></div>`}
      </div>
      <div class="card card-pad"><div class="card-header"><div><div class="eyebrow">继续学习</div><h2>继续学习</h2></div></div><div class="module-grid">
        ${renderModuleCard('words', 'Aa', '单词复习', `${words.due} 条到期 · ${words.coverage}% 已接触`)}
        ${renderModuleCard('simulation', '◷', '整套试卷练习', state.lastExamResult ? `最近可判分 ${state.lastExamResult.correct}/${state.lastExamResult.knownTotal || 0} 题` : `${getContentStats().openFullPractices} 套可开始 · ${getContentStats().simulations} 套已通过完整性验收`)}
      </div></div>
    </section>
    <div style="height:18px"></div>
  `;
}

function renderTaskRow(task, plan) {
  const done = plan.completedIds?.includes(task.id);
  const symbol = task.kind === 'reading' ? '阅' : task.kind === 'listening' ? '听' : task.kind === 'writingTranslation' ? '写' : task.kind === 'review' ? '↻' : task.kind === 'mock' ? '◷' : task.kind === 'practice' ? '✓' : 'Aa';
  const startButton = task.examId ? `<button class="button button-small button-secondary" data-action="start-planned-unit" data-exam-id="${escapeHTML(task.examId)}" data-exam-mode="${escapeHTML(task.mode || 'full')}" data-focus-id="${escapeHTML(task.focusId || '')}" data-unit-id="${escapeHTML(task.unitId || '')}">开始</button>` : '';
  const genericToggle = task.examId ? '' : `<button class="button button-small ${done ? 'button-ghost' : 'button-secondary'}" data-action="toggle-task" data-task-id="${escapeHTML(task.id)}">${done ? '撤销' : '完成'}</button>`;
  return `<div class="task-row ${done ? 'done' : ''}"><div class="task-symbol">${symbol}</div><div><div class="task-title">${escapeHTML(task.label)}</div><div class="task-meta">预计 ${formatMinutes(task.minutes)} · ${escapeHTML(task.detail)}</div></div><div class="task-actions"><span class="pill ${done ? 'pill-green' : ''}">${done ? '已完成' : task.examId ? '待练习' : '待开始'}</span>${done ? '' : startButton}${genericToggle}</div></div>`;
}

function renderModuleCard(view, icon, title, detail) {
  return `<button class="module-card" data-view="${view}"><span class="module-icon">${icon}</span><h3>${title}</h3><p>${escapeHTML(detail)}</p><span class="module-arrow">${view === 'simulation' ? '进入整套练习 →' : '进入模块 →'}</span></button>`;
}

function renderTaskTargetGrid(settings) {
  const selectedDays = new Set((settings.studyWeekdays || []).map(Number));
  const targetsByDay = settings.tasksByDay || DEFAULT_TASK_TARGETS_BY_DAY;
  return `<div class="task-target-grid"><div class="task-target-head">学习日</div><div class="task-target-head">阅读（篇）</div><div class="task-target-head">听力（篇）</div><div class="task-target-head">写译（篇）</div>${DAY_NAMES.map((name, day) => {
    const targets = normalizeTaskTargets(targetsByDay[day]);
    return `<label class="planner-day-label"><input type="checkbox" name="weekday" value="${day}" ${selectedDays.has(day) ? 'checked' : ''}/><span>周${name}</span></label>${TASK_KEYS.map((key) => `<input id="${key}-${day}" data-task-day="${day}" data-task-kind="${key}" type="number" min="0" max="20" step="1" value="${targets[key]}" aria-label="周${name}${TASK_LABELS[key]}篇数"/>`).join('')}`;
  }).join('')}</div>`;
}

function renderPlanner() {
  const settings = viewState.planDraft || state.settings;
  const plan = viewState.planPreview || (viewState.planDraft ? buildPlan(settings) : getDisplayedPlan());
  const calculation = plan.calculations;
  const specialDates = Object.entries(settings.specialDates || {}).sort(([a], [b]) => a.localeCompare(b));
  const calendar = plan.calendar?.days || [];
  const shownCalendar = calendar.slice(0, 84);
  const targetTotals = calculation?.taskTargetTotals || normalizeTaskTargets();
  const actualTotals = calculation?.taskActualTotals || normalizeTaskTargets();
  const gapItems = TASK_KEYS.filter((key) => Number(calculation?.taskGaps?.[key] || 0) > 0).map((key) => `${TASK_LABELS[key]}缺 ${calculation.taskGaps[key]} 篇`);
  return `
    <div class="page-heading"><div><div class="eyebrow">学习日历</div><h1>每天完成什么，由你来定。</h1><p>选择日期范围和每周学习日，再为每个星期填写阅读、听力、写译篇数。系统只负责生成日历、记录完成状态和给出预计用时。</p></div><div class="heading-meta"><span class="date-stamp">${escapeHTML(formatDateRange(settings.startDate, settings.endDate))}</span><span>${calendar.filter((day) => day.active).length} 个有效学习日</span></div></div>
    <div class="planner-layout">
      <form class="card card-pad" id="planner-form">
        <div class="card-header"><div><div class="eyebrow">学习设置</div><h2>你的每日任务</h2></div><span class="card-note">数量由你决定</span></div>
        <div class="form-grid">
          <div class="field"><label for="start-date">开始日期</label><input id="start-date" name="startDate" type="date" value="${escapeHTML(settings.startDate)}" required /><span class="field-help">使用本地日历日期，支持跨月和跨年。</span></div>
          <div class="field"><label for="end-date">结束日期</label><input id="end-date" name="endDate" type="date" value="${escapeHTML(settings.endDate)}" required /><span class="field-help">计划截止日期与可选考试日期分开保存。</span></div>
          <div class="field field-full"><span class="field-label">每周学习日与每天篇数</span>${renderTaskTargetGrid(settings)}<span class="field-help">勾选后，该星期的每个日期都会安排对应篇数；没有勾选的日期不安排必做任务。预计用时仅作参考。</span></div>
          <div class="field"><label for="exam-date">可选考试日期</label><input id="exam-date" name="examDate" type="date" value="${escapeHTML(settings.examDate || '')}"/><span class="field-help">仅作提醒，不会自动认定为官方考试。</span></div>
        </div>
        <div class="card-header" style="margin-top:30px"><div><div class="eyebrow">特殊日期</div><h2>单日调整</h2></div><span class="card-note">优先级高于每周规律</span></div>
        <div class="form-grid"><div class="field"><label for="special-date">日期</label><input id="special-date" type="date" min="${escapeHTML(settings.startDate)}" max="${escapeHTML(settings.endDate)}" /></div><div class="field"><label for="special-type">调整方式</label><select id="special-type"><option value="extra">额外学习日</option><option value="rest">休息日</option><option value="custom">自定义任务</option></select></div><div class="field"><label for="special-note">备注（可选）</label><input id="special-note" type="text" placeholder="例如：出差，只安排阅读" /></div></div>
        <div class="task-target-grid special-task-grid"><div class="task-target-head">单日任务</div><div class="task-target-head">阅读（篇）</div><div class="task-target-head">听力（篇）</div><div class="task-target-head">写译（篇）</div><div class="planner-day-label"><span>数量</span></div><input id="special-reading" type="number" min="0" max="20" step="1" value="1"/><input id="special-listening" type="number" min="0" max="20" step="1" value="1"/><input id="special-writing" type="number" min="0" max="20" step="1" value="0"/></div>
        <div class="field-help">额外学习日和自定义任务使用这里的数量；休息日会清空当天必做任务。</div>
        <div class="form-actions"><button type="button" class="button button-secondary" data-action="add-special">加入特殊日期</button><button type="button" class="button button-primary" data-action="preview-plan">预览计划</button><button type="button" class="button button-primary" data-action="apply-plan">应用计划</button></div>
        ${specialDates.length ? `<div class="special-list" style="margin-top:16px">${specialDates.map(([key, item]) => `<div class="special-row"><div class="special-row-main"><strong>${escapeHTML(formatDate(key))}</strong><span class="pill ${item.type === 'rest' ? 'pill-coral' : 'pill-blue'}">${item.type === 'rest' ? '休息日' : formatTaskSummary(item.tasks || taskTargetsFromMinutes({ 0: item.minutes || 0 })[0])}</span><span class="muted">${escapeHTML(item.note || '')}</span></div><button type="button" class="text-button" data-action="remove-special" data-special-key="${escapeHTML(key)}">移除</button></div>`).join('')}</div>` : `<div class="empty-state" style="margin-top:16px"><strong>还没有特殊日期</strong><span>需要请假、补学或单独调整任务量时再加入。</span></div>`}
      </form>
      <aside class="sticky-card">
        <div class="card estimate-card"><div class="estimate-header"><div><div class="eyebrow">计划预览</div><h2>${viewState.planPreview ? '预览结果' : '当前计划'}</h2></div><span class="pill ${calculation?.feasible ? 'pill-green' : 'pill-coral'}">${calculation?.feasible ? '内容可安排' : '存在内容缺口'}</span></div>
          ${plan.error ? `<div class="notice" style="margin-top:18px"><span class="notice-icon">!</span><div><strong>暂时不能生成计划</strong>${escapeHTML(plan.error)}</div></div>` : `<div class="estimate-number">${calculation.totalTaskUnits}<small>篇已安排</small></div><div class="estimate-list"><div class="estimate-line"><span>实际学习日</span><strong>${calculation.activeDays} 天</strong></div><div class="estimate-line"><span>用户设定总量</span><strong>${calculation.requestedTaskUnits} 篇</strong></div><div class="estimate-line"><span>预计总用时</span><strong>${formatMinutes(calculation.expectedMinutes)}</strong></div><div class="estimate-line"><span>平均每天</span><strong>${formatMinutes(Math.round(calculation.expectedMinutes / Math.max(1, calculation.activeDays)))}</strong></div></div><div class="mini-stat-grid"><div class="mini-stat"><div class="mini-label">阅读</div><strong>${actualTotals.reading}/${targetTotals.reading}</strong></div><div class="mini-stat"><div class="mini-label">听力</div><strong>${actualTotals.listening}/${targetTotals.listening}</strong></div><div class="mini-stat"><div class="mini-label">写译</div><strong>${actualTotals.writingTranslation}/${targetTotals.writingTranslation}</strong></div><div class="mini-stat"><div class="mini-label">预计结束</div><strong>${escapeHTML(formatDate(calculation.projectedEnd, false))}</strong></div></div>`}
           ${gapItems.length ? `<div class="warning-box" style="margin-top:10px"><strong>内容缺口</strong><span>${escapeHTML(gapItems.join('、'))}；只按实际可用的篇章、配对音频与写译材料安排，不会把题目数当成篇数。</span></div>` : ''}
           ${calculation?.legacyCompletedTaskCount ? `<div class="notice" style="margin-top:10px"><span class="notice-icon">i</span><div><strong>保留了 ${calculation.legacyCompletedTaskCount} 条旧版完成记录</strong>旧版记录没有关联具体材料，因此保留作历史，不计入新计划的材料完成率。</div></div>` : ''}
        </div>
        <div class="card card-pad calendar-card"><div class="card-header"><div><div class="eyebrow">计划日历</div><h2>计划日历</h2></div><span class="card-note">${calendar.length > 84 ? '先显示前 84 天' : `${calendar.length} 天`}</span></div><div class="calendar-grid"><div class="calendar-head">日</div><div class="calendar-head">一</div><div class="calendar-head">二</div><div class="calendar-head">三</div><div class="calendar-head">四</div><div class="calendar-head">五</div><div class="calendar-head">六</div>${renderCalendarDays(shownCalendar, plan)}</div></div>
      </aside>
    </div>
  `;
}

function renderCalendarDays(days, plan) {
  if (!days.length) return `<div class="empty-state" style="grid-column:1/-1"><strong>没有可显示的日期</strong><span>先填写合法日期范围。</span></div>`;
  const first = parseDate(days[0].key).getDay();
  const placeholders = Array.from({ length: first }, () => '<div></div>').join('');
  return placeholders + days.map((day) => {
    const tasks = plan.days?.find((item) => item.key === day.key)?.tasks || [];
    const taskUnits = tasks.reduce((sum, task) => sum + Number(task.count || 0), 0);
    return `<div class="calendar-day ${day.active ? '' : 'off'} ${day.key === todayKey() ? 'today' : ''}"><div class="calendar-day-number"><span>${parseDate(day.key).getDate()}</span><small>${day.active ? `${taskUnits} 篇` : '休'}</small></div>${tasks.slice(0, 3).map((task) => { const done = plan.completedIds?.includes(task.id); return `<button type="button" class="calendar-task ${task.kind} ${done ? 'complete' : ''}" title="${escapeHTML(task.detail)}" ${task.examId ? `data-action="start-planned-unit" data-exam-id="${escapeHTML(task.examId)}" data-exam-mode="${escapeHTML(task.mode || 'full')}" data-focus-id="${escapeHTML(task.focusId || '')}" data-unit-id="${escapeHTML(task.unitId || '')}"` : 'disabled'}>${done ? '✓ ' : ''}${escapeHTML(task.label)}</button>`; }).join('')}</div>`;
  }).join('');
}

function renderWords() {
  const filter = viewState.wordFilter.trim().toLowerCase();
  const activeWords = getCurrentWordBatchWords().filter((word) => !getWordProgress(word.id).mastered);
  const words = activeWords.filter((word) => !filter || `${word.word} ${word.meaning} ${(word.collocations || []).join(' ')}`.toLowerCase().includes(filter));
  const current = words[viewState.wordIndex % Math.max(1, words.length)] || words[0];
  const stats = getWordStats();
  const progress = current ? getWordProgress(current.id) : null;
  const status = progress ? wordStatus(progress) : { label: '暂无词条', className: 'pill' };
  if (!current) return `<div class="page-heading"><div><div class="eyebrow">单词复习</div><h1>这一批词已经背完了。</h1><p>点击“已背会”的词不会再次进入背诵队列。你可以导入新的结构化词库，或在报告中查看已背会记录。</p></div><div class="heading-meta"><span class="date-stamp">已标记背会 ${stats.stable}/${stats.total}</span><span>覆盖率 ${stats.coverage}%</span></div></div><div class="empty-state"><strong>${filter ? '没有匹配且尚未背会的词条' : '当前词库中的待背词条已清空'}</strong><span>“下一个”只会跳过并保留词条；只有“已背会”才会让词条退出队列。</span></div>`;
  return `
    <div class="page-heading"><div><div class="eyebrow">单词复习</div><h1>一张卡片，只做两个决定。</h1><p>“已背会”会把词条永久移出当前背诵队列；“下一个”只是跳过，词条仍会在后续再次出现。</p></div><div class="heading-meta"><span class="date-stamp">${stats.stableRate}% 已背会</span><span>覆盖率 ${stats.coverage}% · 可出现 ${activeWords.length} 条</span></div></div>
    <div class="module-toolbar"><div class="filter-row"><span class="pill pill-blue">词库 ${stats.total} 条</span><span class="pill pill-green">已标记背会 ${stats.stable}</span><span class="pill pill-coral">可再次出现 ${stats.due}</span></div><input class="search-input" id="word-search" type="search" aria-label="搜索尚未标记背会的单词" value="${escapeHTML(viewState.wordFilter)}" placeholder="搜索尚未标记背会的单词" /></div>
    <div class="word-layout"><section class="word-card"><div class="word-top"><div><div class="eyebrow">当前单词</div><div class="word-top-meta" style="margin-top:10px"><span class="pill">${escapeHTML(status.label)}</span><span class="pill">已出现 ${progress.seenCount || 0} 次</span></div></div><button class="button button-secondary button-small" data-action="word-favorite" data-word-id="${escapeHTML(current.id)}">${progress.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div><div class="word-main"><h2>${escapeHTML(current.word)}</h2><div><span class="word-phonetic">${escapeHTML(current.phonetic)}</span><span class="word-pos">${escapeHTML(current.pos)}</span></div></div>${viewState.wordShow ? `<div class="word-answer"><strong>${escapeHTML(current.meaning)}</strong><div>常见搭配：${(current.collocations || []).map(escapeHTML).join(' · ')}</div><div class="word-example"><em>${escapeHTML(current.example)}</em></div></div>` : `<div class="word-answer word-hidden">先回忆释义、词性和一个搭配，再点击“显示释义”。</div>`}<div class="word-note-area"><textarea id="word-note" data-note-editor="${escapeHTML(current.id)}" aria-label="单词复习笔记" placeholder="记一个区分点、例句或下次复习提示…">${escapeHTML(state.notes[current.id] || '')}</textarea><button class="button button-secondary button-small" data-action="save-note" data-note-key="${escapeHTML(current.id)}">保存笔记</button></div><div class="word-footer"><div class="two-choice-note"><strong>本次背诵只保留两个选项</strong><span>“下一个”不会改变背会状态。</span></div><div class="hero-actions"><button class="button button-secondary button-small" data-action="word-show">${viewState.wordShow ? '隐藏释义' : '显示释义'}</button><button class="button button-secondary button-small" data-action="word-speak" data-word="${escapeHTML(current.word)}">🔊 本机语音</button><button class="button button-secondary button-small" data-action="word-next">下一个</button><button class="button button-primary" data-action="word-mastered" data-word-id="${escapeHTML(current.id)}">已背会</button></div></div></section><section class="card card-pad"><div class="card-header"><div><div class="eyebrow">WORD LIST</div><h2>尚未背会</h2></div><span class="card-note">${activeWords.length} 条</span></div><div class="word-list">${words.slice(0, 50).map((word) => renderWordListItem(word)).join('') || `<div class="empty-state"><strong>没有匹配词条</strong><span>换一个关键词试试。</span></div>`}</div></section></div><div style="height:18px"></div><div class="notice"><span class="notice-icon">i</span><div><strong>统计口径</strong>词汇覆盖率表示至少出现过一次；“已背会”只记录为你的手动标记，不代表延迟复测已通过。</div></div>
  `;
}

function renderWordListItem(word) {
  const progress = getWordProgress(word.id);
  const status = wordStatus(progress);
  return `<div class="word-list-item"><div><div class="word-list-word">${escapeHTML(word.word)} <span class="muted">${escapeHTML(word.pos)}</span></div><div class="word-list-meaning">${escapeHTML(word.meaning)}</div><div class="word-list-meta"><span class="${status.className}">${status.label}</span>${progress.nextReview ? `<span>下次 ${escapeHTML(formatDate(progress.nextReview, false))}</span>` : ''}</div></div><div class="list-actions"><button class="text-button" data-action="select-word" data-word-id="${escapeHTML(word.id)}">查看</button></div></div>`;
}

function renderPractice() {
  const types = ['全部', ...new Set(content.practice.map((item) => item.type))];
  const filtered = content.practice.filter((item) => viewState.practiceType === '全部' || item.type === viewState.practiceType);
  const question = filtered[viewState.practiceIndex % Math.max(1, filtered.length)];
  const result = question ? state.practiceResults[question.id] : null;
  const selected = result?.selected ?? viewState.practiceSelections[question?.id];
  const completedCount = getPracticeStats().completed;
  return `
<div class="page-heading"><div><div class="eyebrow">专项练习</div><h1>把错题变成下一次的提示。</h1><p>提交前不显示答案；提交后显示你的答案、正确答案和解析。</p></div><div class="heading-meta"><span class="date-stamp">${completedCount} 题已完成</span><span>共 ${content.practice.length} 题</span></div></div>
    <div class="practice-layout"><aside class="card practice-nav">${types.map((type) => `<button class="${viewState.practiceType === type ? 'active' : ''}" data-action="practice-type" data-practice-type="${escapeHTML(type)}"><span>${escapeHTML(type)}</span><small>${type === '全部' ? content.practice.length : content.practice.filter((item) => item.type === type).length}</small></button>`).join('')}</aside><section class="card question-card">${question ? renderQuestion(question, result, selected) : `<div class="empty-state"><strong>暂无此类题目</strong><span>请先导入结构化题目，或切换题型。</span></div>`}</section></div>
  `;
}

function renderQuestion(question, result, selected) {
  const writing = ['写作', '翻译'].includes(question.type);
  const hasAnswer = result?.completed;
  const options = question.options || [];
  return `<div class="question-meta"><span class="pill pill-blue">${escapeHTML(question.type)}</span><span class="pill">${escapeHTML(question.skill)}</span><span class="pill">预计 ${question.minutes} 分钟</span><span class="card-note">${escapeHTML(question.sourceType)}</span></div><h2>${escapeHTML(question.title)}</h2><div class="question-prompt">${escapeHTML(question.prompt)}</div>${writing ? `<div class="writing-box"><textarea id="writing-answer" aria-label="写作或翻译答案" data-question-id="${escapeHTML(question.id)}" placeholder="在这里输入你的答案…">${escapeHTML(viewState.writingDrafts[question.id] || result?.selected || '')}</textarea><div class="card-note">字数：${String(viewState.writingDrafts[question.id] || result?.selected || '').trim().split(/\s+/).filter(Boolean).length} · 提交后只提供结构化自评提示。</div></div>` : `<div class="option-list">${options.map((option, index) => { const isCorrect = hasAnswer && index === question.answer; const isWrong = hasAnswer && index === Number(selected) && index !== question.answer; return `<div class="option ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}"><input type="radio" id="option-${question.id}-${index}" name="practice-option" data-action="practice-option" data-question-id="${escapeHTML(question.id)}" value="${index}" ${String(selected) === String(index) ? 'checked' : ''} ${hasAnswer ? 'disabled' : ''}/><label for="option-${question.id}-${index}"><span class="option-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHTML(option)}</span></label></div>`; }).join('')}</div>`}${hasAnswer ? `<div class="solution"><strong>${result.correct ? '回答正确 · 已计入记录' : '本题需要再回看'}</strong>正确答案：${question.answer !== null && question.answer !== undefined ? escapeHTML(options[question.answer] || '') : '主观题不做自动对错判断'}<br/>${escapeHTML(question.explanation)}</div>` : ''}<div class="note-editor"><label for="practice-note">我的复盘笔记</label><textarea id="practice-note" data-note-editor="${escapeHTML(question.id)}" placeholder="写下定位依据、错因或下次提醒…">${escapeHTML(state.notes[question.id] || '')}</textarea><button class="button button-secondary button-small" data-action="save-note" data-note-key="${escapeHTML(question.id)}">保存笔记</button></div><div class="question-footer"><div class="muted">${hasAnswer ? `已于 ${new Date(result.answeredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 提交` : '提交后才会显示解析'}</div><div class="hero-actions">${hasAnswer ? '<button class="button button-secondary" data-action="practice-next">下一题 →</button>' : `<button class="button button-primary" data-action="practice-submit" data-question-id="${escapeHTML(question.id)}">提交答案</button>`}</div></div>`;
}

function renderGrammar() {
  const units = content.grammarUnits || [];
  const current = units.find((unit) => unit.id === viewState.grammarId) || units[0];
  if (current && !viewState.grammarId) viewState.grammarId = current.id;
  return `
<div class="page-heading"><div><div class="eyebrow">词汇与语法</div><h1>先理解，再把结构用起来。</h1><p>每个单元按“讲解 → 例句 → 易错点 → 配套练习 → 间隔复习”组织，并关联到专项训练。</p></div><div class="heading-meta"><span class="date-stamp">${Object.values(state.grammarDone).filter(Boolean).length}/${units.length} 个单元</span><span>语法单元</span></div></div>
    <div class="grammar-layout"><aside class="card unit-list">${units.map((unit) => `<button class="unit-button ${unit.id === current?.id ? 'active' : ''}" data-action="grammar-select" data-grammar-id="${escapeHTML(unit.id)}"><strong>${escapeHTML(unit.title)}</strong><span>${escapeHTML(unit.summary)}</span></button>`).join('')}</aside>${current ? `<section class="card unit-detail"><div class="eyebrow">UNIT · ${escapeHTML(current.id)}</div><h2>${escapeHTML(current.title)}</h2><p class="page-heading" style="display:block;margin:0;color:var(--ink-soft);font-size:15px;line-height:1.7">${escapeHTML(current.summary)}</p><div class="lesson-section"><h3>例句</h3><ul class="example-list">${current.examples.map((example) => `<li>${escapeHTML(example)}</li>`).join('')}</ul></div><div class="lesson-section"><h3>易错点</h3><ul class="pitfall-list">${current.pitfalls.map((pitfall) => `<li>${escapeHTML(pitfall)}</li>`).join('')}</ul></div><div class="lesson-section"><div class="notice"><span class="notice-icon">↗</span><div><strong>配套练习</strong>建议完成“${escapeHTML(content.practice.find((item) => item.id === current.practiceId)?.title || '专项练习')}”，预计 ${current.minutes} 分钟。</div></div></div><div class="form-actions"><button class="button ${state.grammarDone[current.id] ? 'button-secondary' : 'button-primary'}" data-action="grammar-toggle" data-grammar-id="${escapeHTML(current.id)}">${state.grammarDone[current.id] ? '已完成 · 标记未完成' : '标记本单元完成'}</button><button class="button button-secondary" data-view="practice">去做配套练习 →</button></div></section>` : `<div class="empty-state"><strong>暂无语法单元</strong><span>请先准备结构化学习内容。</span></div>`}</div>
  `;
}

function renderSimulation() {
  if (state.examSession) return renderExam();
  const exam = getRealExam(viewState.realExamId);
  if (exam) return renderRealExam(exam);
  const last = state.lastExamResult;
  const realExams = (content.realExams || []).filter((item) => Number(item.questionCount || item.questions?.length || 0) > 0);
  const mockExams = (content.mockExams || []).filter((item) => Number(item.questionCount || item.questions?.length || 0) > 0);
  const exams = [...realExams, ...mockExams];
  const readyExams = exams.filter((item) => item.fullAvailable === true);
  const openExams = exams.filter((item) => item.fullPracticeEnabled === true);
  const partialRealExams = realExams.filter((item) => item.fullPracticeEnabled === true && item.fullAvailable !== true);
  const partialMockExams = mockExams.filter((item) => item.fullPracticeEnabled === true && item.fullAvailable !== true);
  const renderCatalogSection = (label, title, items, note, id = '') => items.length ? `<section class="exam-catalog-section" ${id ? `id="${id}"` : ''}><div class="section-heading"><div><div class="eyebrow">${label}</div><h2>${title}</h2></div><span class="card-note">${note}</span></div><div class="exam-catalog-grid">${items.map((item) => renderRealExamCard(item)).join('')}</div></section>` : '';
  return `
    <div class="page-heading"><div><div class="eyebrow">整套练习</div><h1>全部试卷，均可开始练习。</h1><p>每套已有题目的试卷都开放整套练习。尚未通过完整性验收的试卷会提示缺项；练习内容以实际加载的题目和资源为准。</p></div><div class="heading-meta"><span class="date-stamp">${openExams.length} 套可开始</span><span>${readyExams.length} 套已通过完整性验收 · ${realExamQuestionCount()} 道已加载题目</span></div></div>
    ${last?.examId ? `<div class="card card-pad" style="margin-bottom:18px"><div class="card-header"><div><div class="eyebrow">最近成绩</div><h2>${escapeHTML(last.title || '最近一次模拟')}</h2></div><span class="pill pill-green">已交卷</span></div><div class="result-score"><div class="result-box"><span>可判分客观题</span><strong>${last.correct}/${last.knownTotal || 0}</strong></div><div class="result-box"><span>已作答</span><strong>${last.answered}/${last.total}</strong></div><div class="result-box"><span>暂未映射答案</span><strong>${Math.max(0, (last.total || 0) - (last.knownTotal || 0))}</strong></div><div class="result-box"><span>用时</span><strong>${formatMinutes(last.elapsedMinutes)}</strong></div></div><div class="card-note">未映射答案的题目不会计入对错。</div></div>` : ''}
    ${openExams.length ? `<div class="full-exam-entry"><div><div class="eyebrow">整套练习入口已开放</div><strong>${openExams.length} 套试卷可直接开始；内容完整性状态会在每套试卷上单独说明。</strong></div><a class="button button-primary" href="#exam-practice-catalog">查看试卷目录</a></div>` : ''}
    ${renderCatalogSection('整卷内容已验收', '已通过完整性验收', readyExams, `${readyExams.length} 套`, 'exam-practice-catalog')}
    ${renderCatalogSection('练习入口已开放', '真题整套练习（部分内容待补）', partialRealExams, `${partialRealExams.length} 套`)}
    ${renderCatalogSection('练习入口已开放', '模拟卷整套练习（部分内容待补）', partialMockExams, `${partialMockExams.length} 套`)}
    ${!exams.length ? '<div class="empty-state"><strong>暂无可用试卷</strong><span>请先生成结构化题目内容。</span></div>' : ''}
  `;
}
function allExams() {
  return [...(content.realExams || []), ...(content.mockExams || [])];
}

function examPeriodLabel(exam) {
  if (exam.period) return String(exam.period);
  if (exam.year && exam.month) return `${exam.year}年${exam.month}月`;
  return exam.sourceType === '模拟练习' ? '模拟卷' : '未标明场次';
}

function getRealExam(examId) {
  const summary = allExams().find((exam) => exam.id === examId) || null;
  const detail = summary ? examDetails.get(examId) : null;
  return detail ? { ...summary, ...detail } : summary;
}

function realExamQuestionCount() {
  return allExams().reduce((sum, exam) => sum + Number(exam.questionCount || exam.questions?.length || 0), 0);
}

function realSessionKey(examId, mode = 'full', unitId = '') {
  return `${examId}::${mode}${unitId ? `::unit-${encodeURIComponent(unitId)}` : ''}`;
}

function realSubjectiveTasksFor(exam) {
  return [
    ...(exam.writing || []).map((task, index) => ({ ...task, id: task.id || `${exam.id}-writing-${index + 1}`, kind: '写作' })),
    ...(exam.translation || []).map((task, index) => ({ ...task, id: task.id || `${exam.id}-translation-${index + 1}`, kind: '翻译' }))
  ];
}

function getRealSession(exam, mode = viewState.realExamMode || 'full', storageKey = '') {
  state.realExamSessions ||= {};
  const activeKey = viewState.realExamId === exam.id && viewState.realExamMode === mode ? viewState.realSessionKey : '';
  const key = storageKey || activeKey || realSessionKey(exam.id, mode);
  if (!state.realExamSessions[key]) {
    state.realExamSessions[key] = {
      examId: exam.id,
      mode,
      startedAt: Date.now(),
      answers: {},
      textAnswers: {},
      listeningEndedAt: null,
      listeningWindowEndsAt: null,
      audioPlaying: false,
      lastSavedAt: null
    };
  }
  return state.realExamSessions[key];
}

function realOptionText(option) {
  return typeof option === 'string' ? option : option?.text || '';
}

function realOptionKey(option, index) {
  return typeof option === 'string' ? String.fromCharCode(65 + index) : option?.key || String.fromCharCode(65 + index);
}

function realQuestionNumber(question, index) {
  return Number(question.number || index + 1);
}

function migrateRealQuestionState(exam) {
  if (!stateReady || !exam?.id || !Array.isArray(exam.questions)) return;
  const sessions = Object.values(state.realExamSessions || {}).filter((session) => session.examId === exam.id);
  let changed = false;
  for (const question of exam.questions) {
    const legacyIds = [...new Set([question.legacyId, ...(question.legacyIds || [])])]
      .filter((legacyId) => legacyId && legacyId !== question.id);
    for (const legacyId of legacyIds) {
      for (const key of ['answers', 'textAnswers']) {
        for (const session of sessions) {
          const values = session?.[key];
          if (!values || !Object.prototype.hasOwnProperty.call(values, legacyId)) continue;
          if (!Object.prototype.hasOwnProperty.call(values, question.id)) values[question.id] = values[legacyId];
          delete values[legacyId];
          changed = true;
        }
      }
      if (state.notes?.[legacyId] && !state.notes[question.id]) {
        state.notes[question.id] = state.notes[legacyId];
        changed = true;
      }
    }
  }
  if (changed) void saveState('');
}

function realQuestionsFor(exam, mode = 'full', unitId = '') {
  const questions = [...(exam.questions || [])]
    .filter((question) => Number(question.number) > 0)
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (mode === 'reading') {
    const readingQuestions = questions.filter((question) => question.type === 'reading');
    const activeUnitId = unitId || (viewState.realExamId === exam.id && viewState.realExamMode === 'reading' ? viewState.realUnitId : '');
    const units = Array.isArray(exam.readingUnits) ? exam.readingUnits : [];
    const unit = activeUnitId ? units.find((item) => item.id === activeUnitId) : null;
    const allowedIds = new Set(unit ? unit.questionIds || [] : units.flatMap((item) => item.questionIds || []));
    return readingQuestions.filter((question) => allowedIds.has(question.id));
  }
  if (mode === 'listening') return questions.filter((question) => question.type === 'listening');
  if (mode === 'writingTranslation') return [];
  return questions;
}

function realExamAudioUrl(exam) {
  const url = exam.audio?.url || '';
  return url ? encodeURI(url) : '';
}

function renderRealExamCard(exam) {
  const listeningCount = Number(exam.listeningCount || (exam.questions || []).filter((question) => question.type === 'listening').length);
  const readingCount = Number(exam.readingCount || (exam.questions || []).filter((question) => question.type === 'reading').length);
  const audioAvailable = Boolean(exam.hasListeningAudio || (listeningCount && exam.audio?.url));
  const sessions = Object.values(state.realExamSessions || {}).filter((item) => item.examId === exam.id);
  const latestByMode = new Map();
  for (const session of sessions.slice().sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))) {
    if (!latestByMode.has(session.mode)) latestByMode.set(session.mode, session);
  }
  const fullAvailable = exam.fullAvailable === true;
  const fullPracticeEnabled = exam.fullPracticeEnabled === true;
  const readingAvailable = (exam.readingUnits || []).length > 0;
  const listeningAvailable = listeningCount > 0 && audioAvailable;
  const sourceLabel = exam.sourceType === '模拟练习' ? '模拟卷' : '真题';
  const status = [...latestByMode.entries()].map(([mode, session]) => `${mode === 'full' ? '整套' : mode === 'reading' ? '阅读' : mode === 'listening' ? '听力' : '写译'}${session.submittedAt ? '已交卷' : '有草稿'}`).join(' · ');
  const contentNote = !fullAvailable && exam.fullUnavailableReasons?.length
    ? `整套练习已开放 · 内容待补：${exam.fullUnavailableReasons.join('、')}` : '';
  const note = [status, contentNote].filter(Boolean).join(' · ');
  return `<article class="exam-catalog-card"><div class="exam-card-top"><div><div class="eyebrow">${sourceLabel} · ${escapeHTML(examPeriodLabel(exam))}</div><h3>${escapeHTML(exam.title)}</h3></div><span class="pill ${fullAvailable ? 'pill-green' : audioAvailable ? 'pill-blue' : ''}">${fullAvailable ? '完整性已验收' : audioAvailable ? '含配对音频' : '音频待补'}</span></div><div class="sim-meta"><span class="pill">${exam.questionCount} 题</span><span class="pill">听力 ${listeningCount}</span><span class="pill">阅读 ${readingCount}</span></div><div class="exam-card-actions"><button class="button button-primary button-small" data-action="exam-open" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="full" ${fullPracticeEnabled ? '' : 'disabled'}>${fullPracticeEnabled ? '开始整套练习' : '暂无可练题目'}</button><button class="button button-secondary button-small" data-action="exam-open" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="reading" ${readingAvailable ? '' : 'disabled'}>阅读专项</button><button class="button button-secondary button-small" data-action="exam-open" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="listening" ${listeningAvailable ? '' : 'disabled'}>听力专项</button></div>${note ? `<div class="card-note" style="margin-top:12px">${escapeHTML(note)}</div>` : ''}</article>`;
}

function realRemainingSeconds(exam, mode, session) {
  if (!session) return 0;
  if (mode === 'listening') {
    if (!session.listeningWindowEndsAt) return null;
    return Math.max(0, Math.ceil((session.listeningWindowEndsAt - Date.now()) / 1000));
  }
  const isPlannedReadingUnit = mode === 'reading'
    && viewState.realExamId === exam.id
    && Boolean(viewState.realUnitId);
  const minutes = mode === 'reading' ? (isPlannedReadingUnit ? TASK_MINUTES.reading : 40)
    : mode === 'writingTranslation' ? 30 : Number(exam.durationMinutes || 130);
  return Math.max(0, minutes * 60 - Math.floor((Date.now() - session.startedAt) / 1000));
}

function renderRealExamHeader(exam, mode, session) {
  const remaining = realRemainingSeconds(exam, mode, session);
  const timerLabel = remaining === null ? (mode === 'listening' ? (session.audioPlaying ? '音频播放中' : '尚未播放') : '—') : formatTimer(remaining);
  const submittedNote = session.submittedAt ? '本次已提交，答案已锁定；可以查看并复盘。' : '交卷前不显示答案，作答会自动保存。';
  const modeLabel = mode === 'full' ? '整套模拟' : mode === 'reading' ? '阅读专项' : mode === 'listening' ? '听力专项' : '写译专项';
  const answerSourcePath = exam.answerSourceFiles?.[0] || exam.questions?.find((question) => question.answerSourcePath)?.answerSourcePath || '';
  const answerSourceLink = session.submittedAt && answerSourcePath
    ? `<a class="button button-secondary button-small answer-source-link" href="/resource/${encodeURIComponent(answerSourcePath)}" target="_blank" rel="noreferrer">打开本套答案解析 ↗</a>`
    : '';
  return `<div class="exam-top real-exam-top"><div><div class="eyebrow">${modeLabel} · ${escapeHTML(examPeriodLabel(exam))}</div><h1>${escapeHTML(exam.title)}</h1><p class="card-note">${submittedNote}</p></div><div class="real-exam-top-actions"><div class="exam-timer" id="real-exam-timer">${timerLabel}</div>${answerSourceLink}<button class="button button-ghost button-small" data-action="real-exam-back">返回试卷列表</button></div></div><div class="exam-mode-switch"><button class="${mode === 'full' ? 'active' : ''}" data-action="exam-mode" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="full">整套模拟</button><button class="${mode === 'reading' ? 'active' : ''}" data-action="exam-mode" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="reading">阅读专项</button><button class="${mode === 'listening' ? 'active' : ''}" data-action="exam-mode" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="listening">听力专项</button><button class="${mode === 'writingTranslation' ? 'active' : ''}" data-action="exam-mode" data-exam-id="${escapeHTML(exam.id)}" data-exam-mode="writingTranslation">写译专项</button></div>`;
}
function renderExamAudioPanel(exam, mode, session) {
  if (!exam.audio?.url) return `<div class="notice audio-missing"><span class="notice-icon">!</span><div><strong>本套暂无可用听力音频</strong>${mode === 'listening' ? '听力专项暂不可开始，补齐对应音频后开放。' : '整套模拟中的听力材料尚未匹配。'}</div></div>`;
  const listeningDone = Boolean(session.listeningEndedAt);
  const playbackStatus = listeningDone ? '听力已结束' : session.audioPlaying ? '正在播放' : '尚未播放';
  return `<div class="audio-panel" id="real-audio-panel"><div class="audio-panel-top"><div><div class="eyebrow">听力音频</div><strong>${escapeHTML(exam.audio.label || '听力材料')}</strong></div><span class="pill ${listeningDone ? 'pill-green' : 'pill-blue'}" data-audio-status>${playbackStatus}</span></div><audio class="exam-audio" data-exam-audio="${escapeHTML(exam.id)}" controls preload="metadata" src="${escapeHTML(realExamAudioUrl(exam))}"></audio>${mode === 'listening' ? `<div class="audio-panel-foot"><span>${listeningDone ? '现在进入 2 分钟答题窗口。' : '练习规则：听力期间只显示选项，不显示题干和原文。播放结束后才开始 2 分钟答题窗口。'}</span></div>` : ''}</div>`;
}

function renderRealChoiceOptions(question, session, { hidePrompt = false, disabled = false } = {}) {
  const selected = session.answers?.[question.id];
  if (question.answerMode === 'text') {
    const fieldId = 'dictation-' + escapeHTML(question.id);
    const fieldValue = escapeHTML(session.textAnswers?.[question.id] || '');
    const disabledAttribute = disabled ? 'disabled' : '';
    return '<div class=\"dictation-answer-control\"><label for=\"' + fieldId + '\">本题听写答案</label><input id=\"' + fieldId + '\" type=\"text\" maxlength=\"500\" autocomplete=\"off\" data-action=\"real-dictation\" data-exam-id=\"' + escapeHTML(session.examId) + '\" data-question-id=\"' + escapeHTML(question.id) + '\" value=\"' + fieldValue + '\" placeholder=\"输入听到的词句…\" ' + disabledAttribute + '/></div>';
  }
  if (question.canonicalStatus === '选项待核验') return `<div class="question-missing"><strong>选项未完整核验，暂不可作答</strong><span>目前识别到 ${(question.options || []).length} 项；为避免误导，本题不显示不完整选项。</span></div>`;
  if (question.canonicalStatus === '待核验占位' || !(question.options || []).length) return `<div class="question-missing"><strong>本题待核验</strong><span>原始材料中未能可靠提取题干或选项，暂不开放作答。</span></div>`;
  if (question.sharedOptionMode === 'paragraph-match') {
    const fieldId = 'paragraph-match-' + escapeHTML(question.id);
    return `<div class="shared-paragraph-answer"><label for="${fieldId}">选择对应段落</label><select id="${fieldId}" data-action="real-answer" data-exam-id="${escapeHTML(session.examId)}" data-question-id="${escapeHTML(question.id)}" aria-label="第 ${realQuestionNumber(question, 0)} 题对应段落" ${disabled ? 'disabled' : ''}><option value="">请选择</option>${question.options.map((option, index) => { const key = realOptionKey(option, index); return `<option value="${escapeHTML(key)}" ${String(selected) === String(key) ? 'selected' : ''}>段落 ${escapeHTML(key)}</option>`; }).join('')}</select></div>`;
  }
  return `<div class="option-list real-option-list">${(question.options || []).map((option, index) => { const key = realOptionKey(option, index); return `<div class="option"><input type="radio" id="real-${escapeHTML(question.id)}-${index}" name="real-${escapeHTML(question.id)}" data-action="real-answer" data-exam-id="${escapeHTML(session.examId)}" data-question-id="${escapeHTML(question.id)}" value="${escapeHTML(key)}" ${String(selected) === String(key) ? 'checked' : ''} ${disabled ? 'disabled' : ''}/><label for="real-${escapeHTML(question.id)}-${index}"><span class="option-letter">${escapeHTML(key)}</span><span>${escapeHTML(realOptionText(option))}</span></label></div>`; }).join('')}</div>`;
}

function safeSubjectivePrompt(task) {
  let text = String(task.prompt || task.text || '').replace(/\r/g, '').trim();
  const marker = /(?:参考范文|参考译文|参考答案|正确答案|答案解析|答案详解|难点注释|审题思路|词汇准备|话题词汇|写作模板|精析精译|解题思路|范文|译文|Sample\s+Essay|Model\s+Answer|Reference\s+Translation)\s*[:：]?/i.exec(text);
  if (marker) text = text.slice(0, marker.index).trim();
  if (task.kind === '翻译' || /translation/i.test(String(task.id || ''))) {
    const lines = text.split('\n');
    const answerLine = lines.findIndex((line) => {
      const letters = (line.match(/[A-Za-z]/g) || []).length;
      const han = (line.match(/[\u3400-\u9fff]/g) || []).length;
      return letters >= 55 && han <= 2 && letters / Math.max(1, line.length) >= 0.5;
    });
    if (answerLine >= 0) text = lines.slice(0, answerLine).join('\n').trim();
    else if ((text.match(/[\u3400-\u9fff]/g) || []).length >= 45) {
      const cut = /[。！？]\s*(?=[A-Z])/.exec(text);
      if (cut) {
        const suffix = text.slice(cut.index + cut[0].length);
        const letters = (suffix.match(/[A-Za-z]/g) || []).length;
        const han = (suffix.match(/[\u3400-\u9fff]/g) || []).length;
        if (letters >= 80 && han <= 2 && letters / Math.max(1, suffix.length) >= 0.45) text = text.slice(0, cut.index + 1).trim();
      }
    }
  }
  return text.length >= 20 ? text : '';
}

function renderRealSubjectiveTask(task, kind, session, index) {
  const value = session.textAnswers?.[task.id] || '';
  const prompt = safeSubjectivePrompt(task);
  const reference = task.referenceAnswer || '';
  const explanation = task.explanation || '';
  const review = session.submittedAt && (reference || explanation)
    ? `<details class="solution"><summary>查看参考答案与解析</summary>${reference ? `<div class="reference-answer">${escapeHTML(reference).replace(/\n/g, '<br>')}</div>` : ''}${explanation ? `<div class="reference-explanation">${escapeHTML(explanation).replace(/\n/g, '<br>')}</div>` : ''}</details>`
    : '';
  return `<article class="real-subjective-card" id="real-subjective-${escapeHTML(task.id)}"><div class="real-question-head"><span class="question-index">${index + 1}</span><span class="pill pill-gold">${kind}</span><span class="card-note">主观题</span></div><div class="real-question-stem">${escapeHTML(prompt || '原题内容尚未可靠提取，本题暂不可用。')}</div><textarea class="real-subjective-input" data-action="real-text" data-exam-id="${escapeHTML(session.examId)}" data-task-id="${escapeHTML(task.id)}" placeholder="在这里输入作答…" ${session.submittedAt || !prompt ? 'disabled' : ''}>${escapeHTML(value)}</textarea><div class="card-note">${session.submittedAt ? '本次已提交，作答已锁定。' : prompt ? '输入内容会自动保存。' : '原题待补录，当前不会收集作答。'}</div>${review}</article>`;
}

function renderRealQuestionReview(question, session) {
  if (!session.submittedAt) return '';
  if (question.answerMode === 'text') {
    const response = String(session.textAnswers?.[question.id] || '').trim() || '未作答';
    const reference = String(question.referenceAnswer || '').trim();
    return `<div class="question-review-note unscored"><strong>听写复盘 · 不自动判分</strong><span>你的答案：${escapeHTML(response)}</span><span>${reference ? `参考答案：${escapeHTML(reference)}` : '暂无可靠参考答案'}</span></div>`;
  }
  const options = question.options || [];
  const optionKey = (option, index) => realOptionKey(option, index).toUpperCase();
  const answerIndex = typeof question.answer === 'number' ? question.answer : -1;
  const expectedKey = String(question.answerKey || (answerIndex >= 0 ? optionKey(options[answerIndex], answerIndex) : question.answer || '')).toUpperCase();
  if (!expectedKey) return `<div class="question-review-note unscored">本题暂无可核验的标准答案，未计入判分。</div>`;
  const selectedKey = String(session.answers?.[question.id] || '').toUpperCase();
  const expectedOption = options.find((option, index) => optionKey(option, index) === expectedKey);
  const expectedText = realOptionText(expectedOption).trim();
  const isCorrect = selectedKey === expectedKey;
  const selectedLabel = selectedKey ? (question.sharedOptionMode === 'paragraph-match' ? `段落 ${selectedKey}` : selectedKey) : '未作答';
  const expectedLabel = question.sharedOptionMode === 'paragraph-match' ? `段落 ${expectedKey}` : `${expectedKey}${expectedText ? ` · ${expectedText}` : ''}`;
  return `<div class="question-review-note ${isCorrect ? 'correct' : 'incorrect'}"><strong>${isCorrect ? '回答正确' : '回答错误'}</strong><span>你的答案：${escapeHTML(selectedLabel)}</span><span>标准答案：${escapeHTML(expectedLabel)}</span></div>`;
}

function renderRealQuestionCard(question, index, session, mode = 'full') {
  const listeningLocked = question.type === 'listening' && question.answerMode !== 'text' && !session.listeningEndedAt && !session.submittedAt && mode !== 'reading';
  const expired = question.type === 'listening'
    && session.listeningWindowEndsAt
    && Date.now() >= Number(session.listeningWindowEndsAt);
  const prompt = question.answerMode === 'text'
    ? '旧版听力填空 · 请结合左侧音频填写空缺内容。 ' + (question.stem || question.prompt || '')
    : question.stem || question.prompt || '';
  return `<article class="real-question-card ${listeningLocked ? 'listening-locked' : ''}" id="real-question-${escapeHTML(question.id)}"><div class="real-question-head"><span class="question-index">${realQuestionNumber(question, index)}</span><span class="pill ${question.type === 'listening' ? 'pill-blue' : 'pill-gold'}">${question.type === 'listening' ? '听力' : '阅读'}</span><span class="card-note">${escapeHTML(question.section || '')}</span></div>${listeningLocked ? `<div class="listening-hidden-notice">听力播放期间不显示题干和原文，只保留选项。</div>` : `<div class="real-question-stem">${escapeHTML(prompt || '请结合左侧材料作答。')}</div>${question.prompt && question.prompt !== prompt ? `<div class="question-prompt">${escapeHTML(question.prompt)}</div>` : ''}`}${renderRealChoiceOptions(question, session, { hidePrompt: listeningLocked, disabled: Boolean(expired || session.submittedAt) })}${renderRealQuestionReview(question, session)}</article>`;
}

function realQuestionAnswered(question, session) {
  return question.answerMode === 'text'
    ? Boolean(String(session.textAnswers?.[question.id] || '').trim())
    : session.answers?.[question.id] !== undefined && session.answers?.[question.id] !== '';
}

function renderRealAnswerSheet(questions, session, label = '答题卡', extraClass = '') {
  const answered = questions.filter((question) => realQuestionAnswered(question, session)).length;
  const known = questions.filter((question) => question.answer !== null && question.answer !== undefined && question.answer !== '');
  const correct = known.filter((question) => String(session.answers?.[question.id] || '').toUpperCase() === String(typeof question.answer === 'number' ? String.fromCharCode(65 + question.answer) : question.answer).toUpperCase()).length;
  const dictationCount = questions.filter((question) => question.answerMode === 'text').length;
  const missingCount = Math.max(0, questions.length - known.length - dictationCount);
  return `<aside class="answer-sheet-pane ${extraClass}"><div class="answer-sheet-head"><div><div class="eyebrow">答题卡</div><h2>${label}</h2></div><span class="pill pill-blue">${answered}/${questions.length}</span></div><div class="answer-sheet-groups">${questions.map((question, index) => `<button class="answer-cell ${realQuestionAnswered(question, session) ? 'answered' : ''}" data-action="real-jump" data-question-id="${escapeHTML(question.id)}" title="跳到第 ${realQuestionNumber(question, index)} 题">${realQuestionNumber(question, index)}</button>`).join('')}</div><div class="answer-sheet-legend"><span><i class="legend-dot answered"></i>已作答</span><span><i class="legend-dot"></i>未作答</span></div>${session.submittedAt ? `<div class="notice"><span class="notice-icon">✓</span><div><strong>本次已交卷</strong>客观题 ${correct}/${known.length} 可判分；听写题 ${dictationCount} 道需自行复盘${missingCount ? `；另有 ${missingCount} 道尚未映射答案` : ''}。</div></div>` : `<button class="button button-primary full-width" data-action="real-exam-submit" data-exam-id="${escapeHTML(session.examId)}">主动交卷</button><p class="card-note">交卷后答案会锁定。</p>`}</aside>`;
}

function refreshRealAnswerIndicators(exam, session) {
  const questions = realQuestionsFor(exam, viewState.realExamMode || 'full');
  const answered = questions.filter((question) => realQuestionAnswered(question, session)).length;
  const byId = new Map(questions.map((question) => [question.id, question]));
  document.querySelectorAll('.answer-sheet-pane').forEach((pane) => {
    const counter = pane.querySelector('.answer-sheet-head .pill');
    if (counter) counter.textContent = `${answered}/${questions.length}`;
    pane.querySelectorAll('[data-action="real-jump"]').forEach((button) => {
      button.classList.toggle('answered', realQuestionAnswered(byId.get(button.dataset.questionId) || {}, session));
    });
  });
}

function renderFullSourceTask(task, kind, index) {
  const prompt = safeSubjectivePrompt(task);
  return `<article class="real-subjective-card full-source-task" id="real-subjective-source-${escapeHTML(task.id)}"><div class="real-question-head"><span class="question-index">${index + 1}</span><span class="pill pill-gold">${kind}</span><span class="card-note">题目原文</span></div><div class="real-question-stem">${escapeHTML(prompt || '原题内容尚未可靠提取，本题暂不可用。')}</div></article>`;
}

function renderWritingTranslationWorkspace(exam, session) {
  const tasks = realSubjectiveTasksFor(exam);
  const heading = viewState.realFocusId ? tasks.find((task) => `real-subjective-${task.id}` === viewState.realFocusId) : null;
  return `<div class="exam-workspace-page">${renderRealExamHeader(exam, 'writingTranslation', session)}<div class="full-paper-workspace"><section class="full-paper-source-pane"><div class="full-paper-column-head"><div><div class="eyebrow">写译题目</div><h2>${heading ? escapeHTML(heading.kind) : '写作与翻译'}</h2></div><span class="pill pill-gold">原题</span></div>${tasks.map((task, index) => renderFullSourceTask(task, task.kind, index)).join('') || `<div class="empty-state"><strong>本套暂无写译题目</strong><span>请从学习日历选择有写译内容的材料。</span></div>`}</section><section class="full-paper-answer-pane"><div class="full-paper-column-head"><div><div class="eyebrow">写译作答区</div><h2>你的回答</h2></div><span class="pill pill-blue">自动保存</span></div><div class="full-answer-section">${tasks.map((task, index) => renderRealSubjectiveTask(task, task.kind, session, index)).join('')}${session.submittedAt ? `<div class="notice"><span class="notice-icon">✓</span><div><strong>本次写译已提交</strong>答案已锁定；系统不会对主观题生成虚构分数。</div></div>` : `<button class="button button-primary" data-action="real-exam-submit" data-exam-id="${escapeHTML(exam.id)}">保存并提交写译练习</button>`}</div></section></div></div>`;
}

function renderFullRealWorkspace(exam, session) {
  const questions = realQuestionsFor(exam, 'full');
  const clozeGroups = getClozeReadingGroups(questions);
  const clozeByPassage = new Map(clozeGroups.map((group) => [group[0].passage, group]));
  const passages = [...new Set(questions.filter((question) => question.passage).map((question) => question.passage))];
  const subjective = realSubjectiveTasksFor(exam);
  const incompleteNotice = exam.fullAvailable === true ? '' : `<div class="notice" role="status"><span class="notice-icon">!</span><div><strong>本套内容尚未通过完整性验收，已开放现有题目练习。</strong>题目和资源以当前已加载内容为准；缺失或待核验题目不会提供虚构题面，未映射答案不计入客观题判分。缺项：${escapeHTML((exam.fullUnavailableReasons || []).join('、') || '部分试题或配套材料未齐')}</div></div>`;
  return `<div class="exam-workspace-page">${renderRealExamHeader(exam, 'full', session)}${incompleteNotice}<div class="full-paper-workspace"><section class="full-paper-source-pane"><div class="full-paper-column-head"><div><div class="eyebrow">真题材料</div><h2>原文与听力</h2></div><span class="pill pill-gold">左侧材料</span></div>${renderExamAudioPanel(exam, 'full', session)}${subjective.map((task, index) => renderFullSourceTask(task, task.kind, index)).join('')}${passages.map((passage, index) => { const group = clozeByPassage.get(passage); const numbers = group ? group.map((question) => Number(question.number)) : []; return `<article class="exam-passage-card"><div class="eyebrow">${group ? `选词填空原文 · 第 ${numbers[0]}–${numbers[numbers.length - 1]} 题` : `阅读原文 ${index + 1}`}</div>${group ? renderClozePassage(passage, numbers) : escapeHTML(passage).replace(/\n/g, '<br><br>')}</article>`; }).join('') || `<div class="empty-state"><strong>本套暂无原文材料</strong><span>可以直接在右侧完成可识别题目。</span></div>`}</section><section class="full-paper-answer-pane">${renderRealAnswerSheet(questions, session, '答题卡', 'full-answer-sheet')}<div class="full-answer-section"><div class="full-paper-column-head"><div><div class="eyebrow">作答区域</div><h2>题目与选项</h2></div><span class="pill pill-blue">右侧作答</span></div>${subjective.map((task, index) => renderRealSubjectiveTask(task, task.kind, session, index)).join('')}${questions.map((question, index) => renderRealQuestionCard(question, index, session, 'full')).join('') || (!subjective.length ? `<div class="empty-state"><strong>本套暂无选择题</strong><span>可以先练习其他套卷。</span></div>` : '')}</div></section></div></div>`;
}

function cleanClozePassage(passage) {
  let text = String(passage || '').replace(/\r/g, '');
  const noteIndex = text.search(/\n\s*注意\s*[:：]/);
  if (noteIndex >= 0) text = text.slice(0, noteIndex);
  else {
    const optionIndex = text.search(/\n\s*A\s*[)）]\s*/);
    if (optionIndex >= 0) text = text.slice(0, optionIndex);
  }
  return text.trim();
}

function clozeOptionIsWord(option) {
  const text = realOptionText(option).trim();
  return Boolean(text) && text.length <= 60 && !/[。！？!?]/.test(text) && !/\bQuestions?\b/i.test(text) && !/注意\s*[:：]/.test(text);
}

function clozeOptionsFor(questions) {
  const options = new Map();
  for (const question of questions) {
    for (const option of question.options || []) {
      const key = realOptionKey(option, 0).trim();
      const text = realOptionText(option).trim();
      if (/^[A-O]$/.test(key) && clozeOptionIsWord(option) && !options.has(key)) options.set(key, { key, text });
    }
  }
  return [...options.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function clozeRangeForNumber(number) {
  const value = Number(number);
  if (value >= 26 && value <= 35) return [26, 35];
  if (value >= 36 && value <= 45) return [36, 45];
  return null;
}

function isClozeReadingQuestion(question) {
  const number = Number(question.number);
  const range = clozeRangeForNumber(number);
  if (question.type !== 'reading' || question.sharedOptionMode === 'paragraph-match' || !range || !question.passage) return false;
  const passage = cleanClozePassage(question.passage);
  const hasNumberBlank = new RegExp(`(?:_{2,}\\s*${number}\\s*_{2,}|(^|[^0-9])${number}(?![0-9]))`).test(passage);
  return hasNumberBlank && clozeOptionsFor([question]).length >= 10;
}

function getClozeReadingGroups(questions) {
  const grouped = new Map();
  for (const question of questions) {
    if (!isClozeReadingQuestion(question)) continue;
    const key = question.passage || question.prompt || question.id;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(question);
  }
  return [...grouped.values()]
    .map((group) => group.sort((left, right) => Number(left.number) - Number(right.number)))
    .filter((group) => {
      const range = clozeRangeForNumber(group[0]?.number);
      return Boolean(range) && group.length === range[1] - range[0] + 1 && group.every((question, index) => Number(question.number) === range[0] + index);
    });
}

function renderClozePassage(passage, numbers = []) {
  const cleanText = escapeHTML(cleanClozePassage(passage));
  const targetNumbers = [...new Set(numbers.map((number) => Number(number)).filter((number) => clozeRangeForNumber(number)))].sort((left, right) => left - right);
  if (!targetNumbers.length) return cleanText.replace(/\n\s*\n/g, '<br><br>').replace(/\n/g, '<br>');
  const numberPattern = targetNumbers.join('|');
  const blankPattern = new RegExp(`_{2,}\\s*(${numberPattern})\\s*_{2,}|(^|[^0-9])(${numberPattern})(?![0-9])`, 'gm');
  return cleanText
    .replace(blankPattern, (_, blankNumber, prefix, plainNumber) => `${prefix || ''}<span class="cloze-blank"><span class="cloze-number">${blankNumber || plainNumber}</span><span class="cloze-line">________</span></span>`)
    .replace(/\n\s*\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function clozeQuestionContext(question) {
  const explicitStem = cleanClozePassage(question.stem);
  if (explicitStem.length >= 20 && explicitStem.length <= 350 && /_{2,}/.test(explicitStem)) return explicitStem;
  const text = cleanClozePassage(question.passage);
  const number = String(Number(question.number));
  const segments = text.split(/\n+|(?<=[.!?])\s+/);
  const segment = segments.find((item) => new RegExp(`(^|[^0-9])${number}(?![0-9])`).test(item)) || question.stem || '';
  return segment.trim().replace(new RegExp(`(^|[^0-9])${number}(?![0-9])`, 'g'), '$1______');
}

function renderClozeReadingGroup(group, session) {
  const options = clozeOptionsFor(group);
  const range = clozeRangeForNumber(group[0]?.number) || [Number(group[0]?.number || 0), Number(group[group.length - 1]?.number || 0)];
  const start = range[0];
  const end = range[1];
  const selectedCount = group.filter((question) => Boolean(session.answers?.[question.id])).length;
  const optionBank = options.map((option) => `<span class="cloze-option-chip"><strong>${escapeHTML(option.key)}</strong>${escapeHTML(option.text)}</span>`).join('');
  const rows = group.map((question) => {
    const selected = String(session.answers?.[question.id] || '');
    const usedByOthers = new Set(group.filter((item) => item.id !== question.id).map((item) => String(session.answers?.[item.id] || '')).filter(Boolean));
    const choices = options.map((option) => `<option value="${escapeHTML(option.key)}" ${selected === option.key ? 'selected' : ''} ${usedByOthers.has(option.key) && selected !== option.key ? 'disabled' : ''}>${escapeHTML(option.key)}) ${escapeHTML(option.text)}</option>`).join('');
    return `<div class="cloze-answer-row"><div class="cloze-answer-number">${Number(question.number)}</div><div class="cloze-answer-context">${escapeHTML(clozeQuestionContext(question))}</div><select aria-label="第${Number(question.number)}题选择" data-action="real-cloze-answer" data-exam-id="${escapeHTML(session.examId)}" data-question-id="${escapeHTML(question.id)}" ${session.submittedAt ? 'disabled' : ''}><option value="">选择词汇</option>${choices}</select></div>`;
  }).join('');
  return `<section class="cloze-group-card"><div class="cloze-group-head"><div><div class="eyebrow">选词填空</div><h2>第 ${start}–${end} 题按顺序作答</h2></div><span class="pill pill-blue">已选 ${selectedCount}/${group.length}</span></div><p class="cloze-help">左侧原文已标出横线；右侧先查看合并词库，再按第 ${start} 题到第 ${end} 题逐项选择。每个词只使用一次。</p><div class="cloze-option-bank">${optionBank}</div><div class="cloze-order-list">${rows}</div></section>`;
}

function renderReadingWorkspace(exam, session) {
  const questions = realQuestionsFor(exam, 'reading', viewState.realUnitId);
  const clozeGroups = getClozeReadingGroups(questions);
  const clozeByPassage = new Map(clozeGroups.map((group) => [group[0].passage, group]));
  const clozeByFirstQuestion = new Map(clozeGroups.map((group) => [group[0].id, group]));
  const clozeQuestionIds = new Set(clozeGroups.flatMap((group) => group.map((question) => question.id)));
  const passages = [...new Set(questions.map((question) => question.passage).filter(Boolean))];
  const partialContentNotice = questions.some((question) => question.canonicalStatus === '选项待核验' || question.canonicalStatus === '待核验占位')
    ? '<div class=\"notice\"><span class=\"notice-icon\">!</span><div><strong>本套有题目材料待核验</strong>题号已保留；未能完整提取的题目会明确标示且不可作答，整套模拟暂不开放。</div></div>'
    : '';
  const questionBlocks = partialContentNotice + questions.map((question, index) => {
    if (clozeByFirstQuestion.has(question.id)) return renderClozeReadingGroup(clozeByFirstQuestion.get(question.id), session);
    if (clozeQuestionIds.has(question.id)) return '';
    return renderRealQuestionCard(question, index, session, 'reading');
  }).join('');
  return `<div class="exam-workspace-page">${renderRealExamHeader(exam, 'reading', session)}<div class="reading-workspace"><article class="reading-passage-pane"><div class="reading-pane-head"><div><div class="eyebrow">阅读原文</div><h2>原文</h2></div><span class="pill pill-gold">可上下滚动</span></div>${passages.length ? passages.map((passage, index) => { const group = clozeByPassage.get(passage); const numbers = group ? group.map((question) => Number(question.number)) : []; const firstQuestion = questions.find((question) => question.passage === passage); const focusNumber = group ? numbers[0] : Number(firstQuestion?.number || 0); return `<section class="reading-passage ${group ? 'cloze-passage' : ''}" id="reading-passage-${focusNumber}"><div class="eyebrow">${group ? `选词填空原文 · 第 ${numbers[0]}–${numbers[numbers.length - 1]} 题已标出横线` : `原文 ${index + 1}`}</div>${group ? renderClozePassage(passage, numbers) : escapeHTML(passage).replace(/\n/g, '<br><br>')}</section>`; }).join('') : '<div class="empty-state"><strong>本节暂无原文</strong><span>请先选择其他套卷。</span></div>'}</article><section class="reading-question-pane"><div class="reading-pane-head"><div><div class="eyebrow">题目与选项</div><h2>题干与选项</h2></div><span class="pill pill-blue">${questions.length} 题</span></div>${questionBlocks}<div class="question-footer"><span class="card-note">${session.submittedAt ? '本次已提交，答案已锁定。' : '选择会自动保存，刷新后恢复。'}</span>${session.submittedAt ? '' : `<button class="button button-primary" data-action="real-exam-submit" data-exam-id="${escapeHTML(session.examId)}">提交本次阅读练习</button>`}</div></section></div></div>`;
}

function renderListeningWorkspace(exam, session) {
  const questions = realQuestionsFor(exam, 'listening');
  const remaining = realRemainingSeconds(exam, 'listening', session);
  const expired = remaining !== null && remaining <= 0;
  const clockLabel = remaining === null ? (session.audioPlaying ? '音频播放中' : '尚未播放') : formatTimer(remaining);
  return `<div class="exam-workspace-page">${renderRealExamHeader(exam, 'listening', session)}<div class="listening-rules card card-pad"><div><div class="eyebrow">听力练习</div><h2>${session.listeningEndedAt ? '听力结束，进入 2 分钟答题窗口' : '听力播放期间只显示选项'}</h2><p>${session.listeningEndedAt ? '考试式练习不再播放下一段材料；请在窗口结束前完成选择。' : '不显示题干和原文。音频支持点击播放、暂停和拖动进度。播放结束后才显示题干并开始 2 分钟答题窗口。'}</p></div><div class="listening-window-clock" id="listening-window-timer">${clockLabel}</div></div><div class="exam-workspace"><main class="exam-question-pane">${renderExamAudioPanel(exam, 'listening', session)}${questions.map((question, index) => renderRealQuestionCard(question, index, session, 'listening')).join('') || `<div class="empty-state"><strong>没有可识别的听力选择题</strong><span>请核对本套试卷是否为英语六级题目。</span></div>`}</main>${renderRealAnswerSheet(questions, session, '听力答题卡')}</div>${expired ? '<div class="notice"><span class="notice-icon">!</span><div><strong>2 分钟答题窗口已结束</strong>仍可查看已保存作答，但本次听力窗口不会自动重置。</div></div>' : ''}</div>`;
}

function renderRealExam(exam) {
  const mode = viewState.realExamMode || 'full';
  const session = getRealSession(exam);
  if (mode === 'reading') return renderReadingWorkspace(exam, session);
  if (mode === 'listening') return renderListeningWorkspace(exam, session);
  if (mode === 'writingTranslation') return renderWritingTranslationWorkspace(exam, session);
  return renderFullRealWorkspace(exam, session);
}

async function loadRealExamDetail(examId) {
  if (examDetails.has(examId)) return examDetails.get(examId);
  if (examDetailLoads.has(examId)) return examDetailLoads.get(examId);
  const summary = allExams().find((item) => item.id === examId);
  if (!summary) throw new Error('没有找到这套结构化试卷。');
  const kind = summary.sourceType === '模拟练习' ? 'mock' : 'real';
  const load = getRequiredJSON(`/api/content/${kind}-exams/${encodeURIComponent(examId)}`, '试卷内容')
    .then((detail) => {
      if (!Array.isArray(detail.questions)) throw new Error('试卷内容缺少题目，未打开空白答题页。');
      if (kind === 'real') migrateRealQuestionState(detail);
      examDetails.set(examId, detail);
      return detail;
    })
    .finally(() => examDetailLoads.delete(examId));
  examDetailLoads.set(examId, load);
  return load;
}

async function startRealExam(examId, mode = 'full', focusId = '', unitId = '') {
  const summary = getRealExam(examId);
  if (!summary) return showToast('没有找到这套结构化试卷。', 'warn');
  if (mode === 'full' && summary.fullPracticeEnabled !== true) return showToast('本套没有可用题目，暂时无法开始整套练习。', 'warn');
  if (mode === 'reading' && unitId && !(summary.readingUnits || []).some((unit) => unit.id === unitId)) return showToast('这篇阅读已不在验收通过的题组中，请重新生成学习计划。', 'warn');
  if (mode === 'reading' && !unitId && !(summary.readingUnits || []).length) return showToast('本套没有通过原文与题组验收的阅读内容，暂不能开始。', 'warn');
  if (mode === 'listening' && !(summary.hasListeningAudio && Number(summary.listeningCount || 0) > 0)) return showToast('本套没有与听力题配对的可用音频，听力专项暂不可用。', 'warn');
  try {
    if (!examDetails.has(examId)) {
      showToast('正在加载本套试卷…');
      await loadRealExamDetail(examId);
    }
  } catch (error) {
    showToast(error.message || '本套试卷暂时无法加载。', 'warn');
    return;
  }
  const exam = getRealExam(examId);
  viewState.realExamId = examId;
  activeView = 'simulation';
  state.lastView = activeView;
  viewState.realExamMode = mode;
  viewState.realFocusId = focusId;
  viewState.realUnitId = unitId;
  const baseSessionKey = realSessionKey(examId, mode);
  let storageKey = unitId ? realSessionKey(examId, mode, unitId) : baseSessionKey;
  if (unitId) {
    const unit = getContentUnits().find((item) => item.id === unitId);
    const completedSession = unit && Object.entries(state.realExamSessions || {})
      .filter(([, session]) => sessionCompletesPlanUnit(unit, session))
      .sort((left, right) => Number(right[1].startedAt || 0) - Number(left[1].startedAt || 0))[0];
    if (completedSession) storageKey = completedSession[0];
  }
  if (!unitId && state.realExamSessions?.[storageKey]?.submittedAt) {
    const attemptPrefix = `${baseSessionKey}::attempt-`;
    const priorAttempts = Object.keys(state.realExamSessions || {}).filter((key) => key.startsWith(attemptPrefix)).map((key) => Number(key.slice(attemptPrefix.length))).filter(Number.isInteger);
    storageKey = `${attemptPrefix}${Math.max(0, ...priorAttempts) + 1}`;
  }
  viewState.realSessionKey = storageKey;
  const session = getRealSession(exam, mode, storageKey);
  if (!session.startedAt) session.startedAt = Date.now();
  saveState('已打开试卷，答题草稿会自动保存');
  render();
  if (focusId) window.requestAnimationFrame(() => document.getElementById(focusId)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

function finishRealExam(examId, { automatic = false } = {}) {
  const exam = getRealExam(examId);
  const mode = viewState.realExamMode || 'full';
  const session = exam ? getRealSession(exam, mode) : null;
  if (!exam || !session) return;
  if (session.submittedAt) return;
  if (!automatic && !window.confirm('确认交卷？交卷后本模式的答案将锁定，且不会覆盖其他练习模式的答题记录。')) return;
  const questions = realQuestionsFor(exam, mode);
  if (viewState.realUnitId) {
    const plannedUnit = getDisplayedPlan()?.days?.flatMap((day) => day.tasks || []).find((task) => task.unitId === viewState.realUnitId && task.examId === examId);
    if (plannedUnit && !sessionCompletesPlanUnit(plannedUnit, { ...session, submittedAt: 'pending-submit' })) {
      if (!automatic) {
        const expected = plannedUnit.kind === 'writingTranslation' ? '请先完成这道写译题（至少输入 20 个字符）。' : '请先完成本篇对应的全部题目，再提交计划任务。';
        showToast(expected, 'warn');
        return;
      }
    }
  }
  const known = questions.filter((question) => question.answer !== null && question.answer !== undefined && question.answer !== '');
  const correct = known.reduce((sum, question) => {
    const answer = question.answer;
    const normalized = typeof answer === 'number' ? String.fromCharCode(65 + answer) : String(answer).toUpperCase();
    return sum + (String(session.answers?.[question.id] || '').toUpperCase() === normalized ? 1 : 0);
  }, 0);
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  if (mode === 'full') {
    state.lastExamResult = {
      examId: exam.id,
      title: exam.title,
      correct,
      knownTotal: known.length,
      answered: questions.filter((question) => session.answers?.[question.id] !== undefined && session.answers?.[question.id] !== '').length,
      total: questions.length,
      elapsedMinutes,
      completedAt: new Date().toISOString()
    };
  }
  session.submittedAt = new Date().toISOString();
  const activityLabel = mode === 'full' ? '整套模拟' : mode === 'reading' ? '阅读专项' : mode === 'listening' ? '听力专项' : '写译专项';
  const unscored = Math.max(0, questions.length - known.length);
  const resultSuffix = mode === 'writingTranslation' ? '已保存作答' : `${correct}/${known.length} 可判分，${unscored} 道暂未映射答案`;
  recordActivity(`${activityLabel} · ${exam.title} · ${resultSuffix}`, elapsedMinutes, mode === 'full' ? '模拟' : mode === 'reading' ? '阅读' : mode === 'listening' ? '听力' : '写译');
  refreshPlanFromRecords();
  viewState.planPreview = null;
  if (viewState.examTimer) window.clearInterval(viewState.examTimer);
  viewState.examTimer = null;
  saveState(automatic ? '时间到，已自动交卷并保存结果' : mode === 'full' ? '已保存整套模拟结果' : '已保存专项练习结果');
  render();
}

function saveRealAnswer(examId, questionId, answer) {
  const exam = getRealExam(examId);
  if (!exam) return;
  const session = getRealSession(exam, viewState.realExamMode || 'full');
  if (session.submittedAt) return;
  session.answers ||= {};
  if (answer) session.answers[questionId] = answer;
  else delete session.answers[questionId];
  session.lastSavedAt = new Date().toISOString();
  saveState('答题草稿已保存');
  refreshRealAnswerIndicators(exam, session);
}

function saveRealDictationAnswer(examId, questionId, answer) {
  const exam = getRealExam(examId);
  if (!exam) return;
  const session = getRealSession(exam, viewState.realExamMode || 'full');
  if (session.submittedAt) return;
  session.textAnswers ||= {};
  session.answers ||= {};
  session.textAnswers[questionId] = answer;
  if (answer.trim()) session.answers[questionId] = answer;
  else delete session.answers[questionId];
  session.lastSavedAt = new Date().toISOString();
  refreshRealAnswerIndicators(exam, session);
  window.clearTimeout(realTextSaveTimer);
  realTextSaveTimer = window.setTimeout(() => saveState('听写作答已保存'), 500);
}

function startListeningWindow(examId) {
  const exam = getRealExam(examId);
  if (!exam) return;
  const session = getRealSession(exam, viewState.realExamMode || 'full');
  if (session.submittedAt) return;
  session.audioPlaying = false;
  if (!session.listeningEndedAt) {
    session.listeningEndedAt = new Date().toISOString();
    session.listeningWindowEndsAt = Date.now() + 120000;
  }
  saveState('已开始 2 分钟听力答题窗口');
  render();
}

function startRealExamTimerLoop() {
  if (viewState.examTimer) window.clearInterval(viewState.examTimer);
  viewState.examTimer = window.setInterval(() => {
    const exam = getRealExam(viewState.realExamId);
    if (!exam) {
      window.clearInterval(viewState.examTimer);
      viewState.examTimer = null;
      return;
    }
    const session = getRealSession(exam, viewState.realExamMode || 'full');
    const remaining = realRemainingSeconds(exam, viewState.realExamMode, session);
    const timer = document.querySelector('#real-exam-timer');
    const windowTimer = document.querySelector('#listening-window-timer');
    const timerLabel = remaining === null ? (viewState.realExamMode === 'listening' ? (session.audioPlaying ? '音频播放中' : '尚未播放') : '—') : formatTimer(remaining);
    if (timer) timer.textContent = timerLabel;
    if (windowTimer) windowTimer.textContent = timerLabel;
    if (remaining !== null && remaining <= 0) {
      if (viewState.realExamMode === 'full') {
        window.clearInterval(viewState.examTimer);
        viewState.examTimer = null;
        finishRealExam(exam.id, { automatic: true });
      } else if (viewState.realExamMode === 'listening' && session.listeningWindowEndsAt) {
        window.clearInterval(viewState.examTimer);
        viewState.examTimer = null;
        showToast('2 分钟听力答题窗口已结束。', 'warn');
        render();
      } else if (viewState.realExamMode === 'reading' || viewState.realExamMode === 'writingTranslation') {
        window.clearInterval(viewState.examTimer);
        viewState.examTimer = null;
        showToast('建议作答时间已到；草稿仍可继续填写。', 'warn');
      }
    }
  }, 1000);
}

function renderExam() {
  const session = state.examSession;
  const questions = getExamQuestions();
  const question = questions[session.current] || questions[0];
  const answer = session.answers?.[question?.id];
  const remaining = getExamRemainingSeconds();
  if (!question) return `<div class="empty-state"><strong>演示卷题目缺失</strong><span>请检查结构化内容。</span></div>`;
  const options = question.options || [];
  return `<div class="exam-shell"><div class="exam-top"><div><div class="eyebrow">正在作答 · ${session.current + 1}/${questions.length}</div><h1>练习试卷</h1><p class="card-note">交卷后查看答案与解析；刷新页面会恢复计时。</p></div><div class="exam-timer" id="exam-timer">${formatTimer(remaining)}</div></div><div class="card question-card"><div class="question-meta"><span class="pill pill-blue">${escapeHTML(question.type)}</span><span class="pill">${escapeHTML(question.skill)}</span></div><h2>${escapeHTML(question.title)}</h2><div class="question-prompt">${escapeHTML(question.prompt)}</div>${options.length ? `<div class="option-list">${options.map((option, index) => `<div class="option"><input type="radio" id="exam-${question.id}-${index}" name="exam-option" data-action="exam-answer" value="${index}" ${String(answer) === String(index) ? 'checked' : ''}/><label for="exam-${question.id}-${index}"><span class="option-letter">${String.fromCharCode(65 + index)}</span><span>${escapeHTML(option)}</span></label></div>`).join('')}</div>` : `<div class="writing-box"><textarea data-action="exam-writing" placeholder="主观题作答区…">${escapeHTML(answer || '')}</textarea></div>`}<div class="answer-grid">${questions.map((item, index) => `<span class="answer-cell ${session.answers?.[item.id] !== undefined ? 'answered' : ''} ${index === session.current ? 'current' : ''}">${index + 1}</span>`).join('')}</div><div class="question-footer"><button class="button button-ghost" data-action="exam-prev" ${session.current === 0 ? 'disabled' : ''}>← 上一题</button><div class="hero-actions">${session.current < questions.length - 1 ? '<button class="button button-secondary" data-action="exam-next">下一题 →</button>' : ''}<button class="button button-primary" data-action="exam-submit">主动交卷</button></div></div></div></div>`;
}

function renderReports() {
  const words = getWordStats();
  const days = Array.from({ length: 7 }, (_, index) => addDays(todayKey(), index - 6));
  const minutes = days.map((key) => getDayMinutes(key));
  const max = Math.max(1, ...minutes);
  const weak = state.lastExamResult ? [{ title: '最近一次整套模拟', type: '整套模拟', wrong: 0, done: 1 }] : [];
  const enoughData = state.activity.length > 0 || words.seen > 0;
  return `
    <div class="page-heading"><div><div class="eyebrow">学习报告</div><h1>只看已经发生的学习。</h1><p>数据不足时明确显示“记录不足”，不生成看似精确的成绩预测。词汇覆盖率统计接触记录；已标记背会率统计你的手动标记。</p></div><div class="heading-meta"><span class="date-stamp">${enoughData ? '持续记录中' : '等待第一条记录'}</span><span>只来自你的学习记录</span></div></div>
    <section class="report-grid"><div><div class="report-metrics"><div class="metric-card"><div class="metric-label">学习分钟</div><div class="number">${state.activity.reduce((sum, item) => sum + Number(item.minutes || 0), 0)}</div><div class="metric-detail">来自已完成动作</div></div><div class="metric-card"><div class="metric-label">词汇覆盖</div><div class="number">${words.coverage}%</div><div class="metric-detail">看过一次也会计入</div></div><div class="metric-card"><div class="metric-label">已标记背会率</div><div class="number">${words.stableRate}%</div><div class="metric-detail">按“已背会”按钮统计，不代表复测成绩</div></div></div><div class="card card-pad"><div class="card-header"><div><div class="eyebrow">最近 7 天</div><h2>学习时长</h2></div><span class="card-note">${Math.max(...minutes)} 分钟峰值</span></div>${enoughData ? `<div class="chart">${days.map((key, index) => `<div class="bar-column"><div class="bar-wrap"><div class="bar" style="height:${Math.max(3, Math.round((minutes[index] / max) * 100))}%" title="${minutes[index]} 分钟"></div></div><div class="bar-label">${parseDate(key).getMonth() + 1}/${parseDate(key).getDate()}</div></div>`).join('')}</div>` : `<div class="empty-state"><strong>记录还不够</strong><span>完成一次单词复习或整套模拟后，这里会开始显示真实时长。</span></div>`}</div></div><div class="card card-pad"><div class="card-header"><div><div class="eyebrow">下一步</div><h2>下一步优先</h2></div></div>${weak.length ? `<div class="weak-list">${weak.map((item) => `<div class="weak-item"><div><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.type)} · ${item.wrong ? '需要回看解析' : '已完成，可继续复盘'}</span></div><span class="weak-percent">${item.wrong ? '回看' : '继续'}</span></div>`).join('')}</div>` : `<div class="empty-state"><strong>还没有整套模拟记录</strong><span>完成一套模拟后，结果会在这里保留。</span></div>`}<div class="notice" style="margin-top:18px"><span class="notice-icon">i</span><div><strong>保持真实</strong>当前没有可靠的官方换算依据，因此不展示预测分数或成绩提升承诺。</div></div></div></section>
  `;
}

function renderResources() {
  const search = viewState.resourceSearch.toLowerCase().trim();
  const filtered = catalog.items.filter((item) => {
    const matchSearch = !search || `${item.name} ${item.relativePath} ${item.topic}`.toLowerCase().includes(search);
    const matchTopic = viewState.resourceTopic === '全部' || item.topic === viewState.resourceTopic;
    const matchKind = viewState.resourceKind === '全部' || item.kind === viewState.resourceKind;
    return matchSearch && matchTopic && matchKind;
  });
  const topics = [...new Set(catalog.items.map((item) => item.topic).filter(Boolean))].sort();
  const kinds = [...new Set(catalog.items.map((item) => item.kind).filter(Boolean))].sort();
  const libraryStatus = catalog.sourceAvailable ? '资料已就绪' : '资料暂不可用';
  const pageCount = Math.max(1, Math.ceil(filtered.length / RESOURCE_PAGE_SIZE));
  viewState.resourcePage = Math.min(Math.max(0, viewState.resourcePage), pageCount - 1);
  const pageStart = viewState.resourcePage * RESOURCE_PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + RESOURCE_PAGE_SIZE);
  const pageRange = filtered.length ? `${pageStart + 1}–${Math.min(pageStart + RESOURCE_PAGE_SIZE, filtered.length)}` : '0';
  const pagination = filtered.length > RESOURCE_PAGE_SIZE
    ? `<nav class="resource-pagination" aria-label="学习资料分页"><span>显示 ${pageRange} 项，共 ${filtered.length} 项</span><div><button class="button button-secondary button-small" data-action="resource-page" data-delta="-1" ${viewState.resourcePage <= 0 ? 'disabled' : ''}>上一页</button><span>第 ${viewState.resourcePage + 1} / ${pageCount} 页</span><button class="button button-secondary button-small" data-action="resource-page" data-delta="1" ${viewState.resourcePage >= pageCount - 1 ? 'disabled' : ''}>下一页</button></div></nav>`
    : `<div class="resource-pagination" aria-live="polite">显示 ${pageRange} 项，共 ${filtered.length} 项</div>`;
  return `
    <div class="page-heading"><div><div class="eyebrow">学习资料</div><h1>需要时，回到资料。</h1><p>按年份、主题和格式查找音频、试卷与文档，打开后即可继续学习。</p></div><div class="heading-meta"><span class="date-stamp">${catalog.totalFiles || 0} 项资料</span><span>${escapeHTML(libraryStatus)}</span></div></div>
    <div class="resource-summary"><div class="mini-stat"><div class="mini-label">资料总数</div><strong>${catalog.totalFiles || 0}</strong></div><div class="mini-stat"><div class="mini-label">占用空间</div><strong>${formatBytes(catalog.totalBytes || 0)}</strong></div><div class="mini-stat"><div class="mini-label">音频</div><strong>${catalog.summary?.audio || 0}</strong></div><div class="mini-stat"><div class="mini-label">文档与 PDF</div><strong>${catalog.summary?.documents || 0}</strong></div></div>
    <div class="card resource-table"><div class="card-pad" style="padding-bottom:5px"><div class="resource-filter-grid"><input id="resource-search" type="search" aria-label="搜索学习资料" value="${escapeHTML(viewState.resourceSearch)}" placeholder="搜索文件名、年份或目录"/><select id="resource-topic" aria-label="按主题筛选资料"><option>全部</option>${topics.map((topic) => `<option ${topic === viewState.resourceTopic ? 'selected' : ''}>${escapeHTML(topic)}</option>`).join('')}</select><select id="resource-kind" aria-label="按文件格式筛选资料"><option>全部</option>${kinds.map((kind) => `<option ${kind === viewState.resourceKind ? 'selected' : ''}>${escapeHTML(kind)}</option>`).join('')}</select></div></div><div class="resource-table-head"><span>文件</span><span>分类</span><span>格式</span><span>操作</span></div><div id="resource-results" role="region" aria-label="资料筛选结果">${pageItems.map((item) => renderResourceRow(item)).join('') || `<div class="resource-empty">没有匹配资料。</div>`}</div>${pagination}</div>
    <div style="height:18px"></div><div class="notice"><span class="notice-icon">i</span><div><strong>使用说明</strong>音频、文档和试卷可以在对应学习模块中直接打开；资料暂不可用时，请稍后重试。</div></div>
  `;
}

function renderResourceRow(item) {
  const href = `/resource/${encodeURIComponent(item.relativePath)}`;
  const action = ['audio', 'pdf', 'image', 'text', 'transcript'].includes(item.kind) ? '打开' : '查看';
  return `<div class="resource-row"><div><div class="resource-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}</div></div><div class="resource-cell">${escapeHTML(item.topic || '其他')}</div><div class="resource-cell">${escapeHTML(item.extension || item.kind)}</div><div><a class="resource-open" href="${href}" target="_blank" rel="noreferrer">${action} ↗</a></div></div>`;
}

function readPlannerForm() {
  const form = document.querySelector('#planner-form');
  if (!form) return state.settings;
  const weekdays = [...form.querySelectorAll('input[name="weekday"]:checked')].map((input) => Number(input.value));
  const tasksByDay = {};
  form.querySelectorAll('[data-task-day]').forEach((input) => {
    const day = input.dataset.taskDay;
    tasksByDay[day] = tasksByDay[day] || {};
    tasksByDay[day][input.dataset.taskKind] = Math.max(0, Math.min(20, Math.floor(Number(input.value || 0))));
  });
  const focus = state.settings.focus || ['阅读', '听力'];
  return {
    ...state.settings,
    startDate: form.elements.startDate.value,
    endDate: form.elements.endDate.value,
    studyWeekdays: weekdays,
    tasksByDay: cloneTaskTargetsByDay(tasksByDay),
    mode: 'tasks',
    bufferPercent: 0,
    examDate: form.elements.examDate.value,
    targets: { ...state.settings.targets },
    focus
  };
}

function getExamQuestions() {
  const ids = content.demoSimulation?.questionIds || [];
  return ids.map((id) => content.practice.find((item) => item.id === id)).filter(Boolean);
}

function getExamRemainingSeconds() {
  if (!state.examSession) return 0;
  const duration = Number(content.demoSimulation?.minutes || 45) * 60;
  const elapsed = Math.floor((Date.now() - state.examSession.startedAt) / 1000);
  return Math.max(0, duration - elapsed);
}

function formatTimer(seconds) {
  const value = Math.max(0, seconds);
  const minutes = Math.floor(value / 60).toString().padStart(2, '0');
  const rest = (value % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function startExamTimerLoop() {
  if (viewState.examTimer) window.clearInterval(viewState.examTimer);
  viewState.examTimer = window.setInterval(() => {
    const timer = document.querySelector('#exam-timer');
    if (!timer || !state.examSession) {
      window.clearInterval(viewState.examTimer);
      viewState.examTimer = null;
      return;
    }
    const remaining = getExamRemainingSeconds();
    timer.textContent = formatTimer(remaining);
    if (remaining <= 0) {
      window.clearInterval(viewState.examTimer);
      viewState.examTimer = null;
      finishExam();
    }
  }, 1000);
}

function rateWord(wordId, rating) {
  const previous = getWordProgress(wordId);
  const word = content.words.find((item) => item.id === wordId);
  const stage = Math.min(3, Number(previous.stage || 0) + 1);
  state.wordProgress[wordId] = {
    ...previous,
    stage,
    mastered: rating === 'mastered' ? true : Boolean(previous.mastered),
    nextReview: rating === 'mastered' ? null : todayKey(),
    seenCount: Number(previous.seenCount || 0) + 1,
    lastRating: rating,
    lastSeen: new Date().toISOString()
  };
  recordActivity(`单词复习 · ${word?.word || wordId}`, 2, '单词');
  refreshPlanFromRecords();
  viewState.wordShow = false;
  if (rating !== 'mastered') viewState.wordIndex += 1;
  saveState('已保存这次复习');
  render();
}

function markWordMastered(wordId) {
  rateWord(wordId, 'mastered');
}

function skipWord(wordId) {
  if (!content.words.some((word) => word.id === wordId)) return;
  const previous = getWordProgress(wordId);
  state.wordProgress[wordId] = {
    ...previous,
    seenCount: Number(previous.seenCount || 0) + 1,
    lastRating: 'next',
    lastSeen: new Date().toISOString()
  };
  viewState.wordIndex += 1;
  viewState.wordShow = false;
  saveState('已记录本次接触；此词仍保留在未背会队列中');
  render();
}

function submitPractice(questionId) {
  const question = content.practice.find((item) => item.id === questionId);
  if (!question) return;
  const writing = ['写作', '翻译'].includes(question.type);
  const selected = writing ? (viewState.writingDrafts[questionId] || '').trim() : viewState.practiceSelections[questionId];
  if (writing && !selected) return showToast('先输入一段答案，再提交。', 'warn');
  if (!writing && selected === undefined) return showToast('请选择一个选项。', 'warn');
  const correct = writing ? null : Number(selected) === Number(question.answer);
  state.practiceResults[questionId] = { selected, correct, completed: true, answeredAt: new Date().toISOString() };
  recordActivity(`专项训练 · ${question.type}`, question.minutes, '专项');
  refreshPlanFromRecords();
  saveState('已保存答题记录');
  render();
}

function finishExam() {
  if (!state.examSession) return;
  const questions = getExamQuestions();
  const correct = questions.reduce((sum, question) => sum + (question.answer !== null && Number(state.examSession.answers?.[question.id]) === Number(question.answer) ? 1 : 0), 0);
  const startedAt = state.examSession.startedAt;
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  state.lastExamResult = { correct, total: questions.filter((question) => question.answer !== null && question.answer !== undefined).length, elapsedMinutes, completedAt: new Date().toISOString() };
  state.examSession = null;
  recordActivity('整套模拟', elapsedMinutes, '模拟');
  refreshPlanFromRecords();
  saveState('已保存模拟结果');
  render();
}

async function exportData() {
  // Export the visible in-memory state so a draft can still be backed up after
  // a revision conflict or a failed local-storage write.
  const payload = {
    ok: true,
    format: 'cet6-study-desk-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    state: structuredClone(state)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `六级复习备份-${todayKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  document.querySelector('#backup-meta').textContent = `已生成备份：${new Date().toLocaleString('zh-CN')}。`;
  showToast('备份文件已生成，请妥善保存。');
}

async function importData(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.format !== 'cet6-study-desk-backup' || !payload.state?.settings) throw new Error('format');
    const confirmed = window.confirm('导入会覆盖当前学习记录。是否已经备份当前数据并继续？');
    if (!confirmed) return;
    const response = await fetch('/api/account/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok || !result.state) throw new Error(result.error || 'import failed');
    state = hydrateState(result.state);
    showToast('备份已恢复并写入数据库。');
    activeView = state.lastView && VIEW_NAMES[state.lastView] ? state.lastView : 'home';
    backupDialog?.close();
    render();
  } catch {
    showToast('导入失败：文件格式不受支持或内容不完整。', 'warn');
  }
}

function addSpecialDate() {
  const date = document.querySelector('#special-date')?.value;
  const type = document.querySelector('#special-type')?.value;
  const tasks = normalizeTaskTargets({
    reading: document.querySelector('#special-reading')?.value,
    listening: document.querySelector('#special-listening')?.value,
    writingTranslation: document.querySelector('#special-writing')?.value
  });
  const note = document.querySelector('#special-note')?.value.trim();
  if (!date) return showToast('先选择一个特殊日期。', 'warn');
  if (date < state.settings.startDate || date > state.settings.endDate) return showToast('特殊日期需要在学习日期范围内。', 'warn');
  if (type !== 'rest' && totalTaskUnits(tasks) <= 0) return showToast('请为特殊学习日填写至少一篇任务，或选择休息日。', 'warn');
  state.settings.specialDates[date] = { type, tasks: type === 'rest' ? normalizeTaskTargets() : tasks, note };
  viewState.planDraft = null;
  viewState.planPreview = null;
  saveState('已保存特殊日期');
  render();
}

function applyPlan(usePreview = false) {
  const settings = viewState.planDraft || readPlannerForm();
  if (!settings.startDate || !settings.endDate || settings.endDate < settings.startDate) return showToast('请检查日期范围。', 'warn');
  if (!settings.studyWeekdays.length && !Object.values(settings.specialDates || {}).some((item) => ['extra', 'custom'].includes(item.type))) return showToast('至少选择一个学习日，或添加特殊任务日。', 'warn');
  const plan = usePreview && viewState.planPreview ? viewState.planPreview : buildPlan(settings);
  if (plan.error) return showToast(plan.error, 'warn');
  state.settings = settings;
  state.plan = plan;
  state.planHistory = [{
    id: `plan-${Date.now()}`,
    appliedAt: new Date().toISOString(),
    mode: settings.mode,
    startDate: settings.startDate,
    endDate: settings.endDate,
    activeDays: plan.calculations?.activeDays || 0,
    availableMinutes: plan.calculations?.availableMinutes || 0,
    expectedMinutes: plan.calculations?.expectedMinutes || 0,
    gapMinutes: plan.calculations?.gapMinutes || 0
  }, ...(state.planHistory || [])].slice(0, 30);
  viewState.planDraft = null;
  viewState.planPreview = null;
  recordActivity('调整个人学习计划', 3, '计划');
  saveState(plan.error ? '已保存设置，但计划仍有缺口' : '学习计划已应用');
  render();
}

function toggleTask(taskId) {
  const plan = state.plan?.version >= 2 ? state.plan : buildPlan(state.settings);
  const targetTask = plan.days.flatMap((day) => day.tasks).find((task) => task.id === taskId);
  if (targetTask?.examId) return showToast('此任务需完成对应材料并交卷后自动标记，不能手动勾选。', 'warn');
  const ids = new Set(plan.completedIds || []);
  if (ids.has(taskId)) ids.delete(taskId);
  else ids.add(taskId);
  const tasks = plan.days.flatMap((day) => day.tasks);
  const completedTasks = tasks.filter((task) => ids.has(task.id));
  state.plan = { ...plan, completedIds: [...ids], calculations: { ...plan.calculations, completedMinutes: completedTasks.reduce((sum, task) => sum + task.minutes, 0), completedTaskUnits: completedTasks.reduce((sum, task) => sum + task.count, 0) } };
  recordActivity(ids.has(taskId) ? '完成计划任务' : '撤销计划任务', 0, '计划');
  saveState('任务状态已保存');
  render();
}

function startSimulation() {
  state.examSession = { id: content.demoSimulation.id, startedAt: Date.now(), current: 0, answers: {} };
  state.lastExamResult = null;
  saveState('已开始模拟，计时已保存');
  render();
}

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool || window.__cet6WebMcpRegistered) return;
  window.__cet6WebMcpRegistered = true;
  const lifecycle = new AbortController();
  const tools = [
    {
      name: 'read_learning_plan',
      title: '读取学习计划',
      description: '读取当前个人学习日历的日期、每日阅读/听力/写译任务数量、预计用时和今日任务；不修改数据。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => {
        const plan = getDisplayedPlan();
        return { settings: state.settings, calculations: plan.calculations, today: getTodayPlanDay(plan) };
      }
    },
    {
      name: 'navigate_learning_area',
      title: '打开学习模块',
      description: '打开今日、学习日历、单词、整套模拟、报告或资料模块。',
      inputSchema: { type: 'object', properties: { view: { type: 'string', enum: Object.keys(VIEW_NAMES) } }, required: ['view'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: (input) => {
        if (!VIEW_NAMES[input?.view]) throw new Error('未知学习模块');
        setView(input.view);
        return { view: input.view, title: VIEW_NAMES[input.view] };
      }
    },
    {
      name: 'record_word_review',
      title: '记录单词复习',
      description: '使用和界面相同的两个选择记录词条：已背会会移出队列，下一个会保留再次出现资格。',
      inputSchema: { type: 'object', properties: { wordId: { type: 'string' }, action: { type: 'string', enum: ['mastered', 'next'] } }, required: ['wordId', 'action'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: async (input) => {
        if (!content.words.some((word) => word.id === input?.wordId)) throw new Error('未知词条');
        if (!['mastered', 'next'].includes(input?.action)) throw new Error('无效操作');
        if (input.action === 'mastered') rateWord(input.wordId, 'mastered');
        else skipWord(input.wordId);
        return { wordId: input.wordId, progress: getWordProgress(input.wordId) };
      }
    }
  ];
  tools.forEach((tool) => Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}));
  window.addEventListener('beforeunload', () => lifecycle.abort(), { once: true });
}

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    event.preventDefault();
    setView(viewButton.dataset.view);
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === 'toggle-sidebar') {
    viewState.sidebarOpen = !viewState.sidebarOpen;
    sidebar.classList.toggle('open', viewState.sidebarOpen);
  } else if (action === 'open-backup') {
    backupDialog?.showModal();
  } else if (action === 'close-backup') {
    backupDialog?.close();
  } else if (action === 'export-data') {
    exportData();
  } else if (action === 'word-show') {
    viewState.wordShow = !viewState.wordShow;
    render();
  } else if (action === 'word-next') {
    skipWord(document.querySelector('.word-card [data-action="word-mastered"]')?.dataset.wordId);
  } else if (action === 'word-rate') {
    rateWord(actionButton.dataset.wordId, actionButton.dataset.rating);
  } else if (action === 'word-mastered') {
    markWordMastered(actionButton.dataset.wordId);
  } else if (action === 'word-favorite') {
    const wordId = actionButton.dataset.wordId;
    const progress = getWordProgress(wordId);
    state.wordProgress[wordId] = { ...progress, favorite: !progress.favorite };
    saveState('收藏状态已保存');
    render();
  } else if (action === 'save-note') {
    const noteKey = actionButton.dataset.noteKey;
    const editor = document.querySelector(`[data-note-editor="${CSS.escape(noteKey)}"]`);
    if (editor) {
      state.notes[noteKey] = editor.value.trim();
      recordActivity('保存复盘笔记', 1, '复盘');
      saveState('复盘笔记已保存');
      render();
    }
  } else if (action === 'word-speak') {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(actionButton.dataset.word);
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
    } else showToast('当前浏览器不支持本机语音。', 'warn');
  } else if (action === 'select-word') {
    const index = getCurrentWordBatchWords().filter((word) => !getWordProgress(word.id).mastered).findIndex((word) => word.id === actionButton.dataset.wordId);
    if (index >= 0) { viewState.wordIndex = index; viewState.wordShow = true; render(); }
  } else if (action === 'practice-type') {
    viewState.practiceType = actionButton.dataset.practiceType;
    viewState.practiceIndex = 0;
    render();
  } else if (action === 'practice-submit') {
    submitPractice(actionButton.dataset.questionId);
  } else if (action === 'practice-next') {
    viewState.practiceIndex += 1;
    render();
  } else if (action === 'grammar-select') {
    viewState.grammarId = actionButton.dataset.grammarId;
    render();
  } else if (action === 'grammar-toggle') {
    const id = actionButton.dataset.grammarId;
    state.grammarDone[id] = !state.grammarDone[id];
    recordActivity(`语法单元 · ${content.grammarUnits.find((unit) => unit.id === id)?.title || ''}`, 10, '语法');
    saveState('语法单元状态已保存');
    render();
  } else if (action === 'simulation-start') {
    startSimulation();
  } else if (action === 'exam-prev') {
    if (state.examSession) { state.examSession.current = Math.max(0, state.examSession.current - 1); render(); }
  } else if (action === 'exam-next') {
    if (state.examSession) { state.examSession.current = Math.min(getExamQuestions().length - 1, state.examSession.current + 1); render(); }
  } else if (action === 'exam-submit') {
    finishExam();
  } else if (action === 'preview-plan') {
    viewState.planDraft = readPlannerForm();
    viewState.planPreview = buildPlan(viewState.planDraft);
    render();
    showToast('已生成预览，确认后点击“应用计划”。');
  } else if (action === 'apply-plan') {
    applyPlan(Boolean(viewState.planPreview));
  } else if (action === 'add-special') {
    addSpecialDate();
  } else if (action === 'remove-special') {
    delete state.settings.specialDates[actionButton.dataset.specialKey];
    viewState.planDraft = null;
    viewState.planPreview = null;
    saveState('已移除特殊日期');
    render();
  } else if (action === 'toggle-task') {
    toggleTask(actionButton.dataset.taskId);
  } else if (action === 'start-planned-unit') {
    startRealExam(actionButton.dataset.examId, actionButton.dataset.examMode || 'full', actionButton.dataset.focusId || '', actionButton.dataset.unitId || '');
  } else if (action === 'resource-page') {
    const pageCount = Math.max(1, Math.ceil(catalog.items.filter((item) => {
      const search = viewState.resourceSearch.toLowerCase().trim();
      return (!search || `${item.name} ${item.relativePath} ${item.topic}`.toLowerCase().includes(search))
        && (viewState.resourceTopic === '全部' || item.topic === viewState.resourceTopic)
        && (viewState.resourceKind === '全部' || item.kind === viewState.resourceKind);
    }).length / RESOURCE_PAGE_SIZE));
    viewState.resourcePage = Math.min(pageCount - 1, Math.max(0, viewState.resourcePage + Number(actionButton.dataset.delta || 0)));
    render();
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'exam-open') {
    startRealExam(button.dataset.examId, button.dataset.examMode || 'full');
  } else if (action === 'exam-mode') {
    startRealExam(button.dataset.examId, button.dataset.examMode || 'full');
  } else if (action === 'real-exam-back') {
    viewState.realExamId = null;
    viewState.realSessionKey = '';
    viewState.realUnitId = '';
    viewState.realFocusId = '';
    if (viewState.examTimer) window.clearInterval(viewState.examTimer);
    viewState.examTimer = null;
    render();
  } else if (action === 'real-exam-submit') {
    finishRealExam(button.dataset.examId);
  } else if (action === 'real-jump') {
    document.querySelector(`#real-question-${CSS.escape(button.dataset.questionId)}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (action === 'listening-start-window') {
    startListeningWindow(button.dataset.examId);
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'import-file') importData(target.files?.[0]);
  if (target.matches('[data-action="practice-option"]')) {
    viewState.practiceSelections[target.dataset.questionId] = target.value;
  }
  if (target.matches('[data-action="exam-answer"]') && state.examSession) {
    const question = getExamQuestions()[state.examSession.current];
    if (question) {
      state.examSession.answers[question.id] = target.value;
      saveState('答题草稿已保存');
      render();
    }
  }
  if (target.id === 'resource-topic') { viewState.resourceTopic = target.value; viewState.resourcePage = 0; render(); }
  if (target.id === 'resource-kind') { viewState.resourceKind = target.value; viewState.resourcePage = 0; render(); }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-action="real-answer"], [data-action="real-cloze-answer"]')) {
    saveRealAnswer(target.dataset.examId, target.dataset.questionId, target.value);
  }
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches('[data-action="real-dictation"]')) {
    saveRealDictationAnswer(target.dataset.examId, target.dataset.questionId, target.value);
    return;
  }
  if (!target.matches('[data-action="real-text"]')) return;
  const exam = getRealExam(target.dataset.examId);
  if (!exam) return;
  const session = getRealSession(exam, viewState.realExamMode || 'full');
  if (session.submittedAt) return;
  session.textAnswers ||= {};
  session.textAnswers[target.dataset.taskId] = target.value;
  session.lastSavedAt = new Date().toISOString();
  window.clearTimeout(realTextSaveTimer);
  realTextSaveTimer = window.setTimeout(() => saveState('主观题草稿已保存'), 500);
});

document.addEventListener('ended', (event) => {
  const audio = event.target;
  if (!(audio instanceof HTMLMediaElement) || !audio.matches('[data-exam-audio]')) return;
  startListeningWindow(audio.dataset.examAudio);
}, true);

function handleExamAudioPlayback(event) {
  const audio = event.target;
  if (!(audio instanceof HTMLMediaElement) || !audio.matches('[data-exam-audio]')) return;
  const exam = getRealExam(audio.dataset.examAudio);
  if (!exam) return;
  const mode = viewState.realExamMode || 'full';
  const session = getRealSession(exam, mode);
  if (event.type === 'play' && mode === 'listening' && session.listeningEndedAt) {
    audio.pause();
    showToast('听力播放已经结束，请在 2 分钟答题窗口内作答。', 'warn');
    return;
  }
  session.audioPlaying = event.type === 'play' && !audio.ended;
  const status = document.querySelector('[data-audio-status]');
  if (status && !session.listeningEndedAt) status.textContent = session.audioPlaying ? '正在播放' : audio.currentTime > 0 ? '已暂停' : '尚未播放';
  const clock = document.querySelector('#real-exam-timer, #listening-window-timer');
  if (clock && mode === 'listening' && !session.listeningWindowEndsAt) {
    clock.textContent = session.audioPlaying ? '音频播放中' : audio.currentTime > 0 ? '已暂停' : '尚未播放';
  }
}

document.addEventListener('play', handleExamAudioPlayback, true);
document.addEventListener('pause', handleExamAudioPlayback, true);

document.addEventListener('compositionstart', (event) => {
  if (event.target.id === 'word-search' || event.target.id === 'resource-search') searchCompositionActive = true;
});

document.addEventListener('compositionend', (event) => {
  const target = event.target;
  if (target.id !== 'word-search' && target.id !== 'resource-search') return;
  searchCompositionActive = false;
  if (target.id === 'word-search') { viewState.wordFilter = target.value; viewState.wordIndex = 0; }
  if (target.id === 'resource-search') { viewState.resourceSearch = target.value; viewState.resourcePage = 0; }
  rerenderSearchPreservingFocus(target);
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'word-search') {
    viewState.wordFilter = target.value;
    viewState.wordIndex = 0;
    if (!searchCompositionActive && !event.isComposing) rerenderSearchPreservingFocus(target);
  }
  if (target.id === 'resource-search') {
    viewState.resourceSearch = target.value;
    viewState.resourcePage = 0;
    if (!searchCompositionActive && !event.isComposing) rerenderSearchPreservingFocus(target);
  }
  if (target.id === 'writing-answer') { viewState.writingDrafts[target.dataset.questionId] = target.value; }
  if (target.matches('[data-action="exam-writing"]') && state.examSession) {
    const question = getExamQuestions()[state.examSession.current];
    if (question) state.examSession.answers[question.id] = target.value;
  }
});

function flushPendingStateSave() {
  if (!stateReady) return;
  window.clearTimeout(realTextSaveTimer);
  realTextSaveTimer = null;
  void saveState('');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPendingStateSave();
});
window.addEventListener('pagehide', flushPendingStateSave);

/* ---------------- 注册 / 登录 ---------------- */

let authMode = 'login';

function showAuthScreen(message = '') {
  authLoading.hidden = true;
  appShell.hidden = true;
  authScreen.hidden = false;
  if (message) {
    authError.textContent = message;
    authError.hidden = false;
  }
  authUsernameInput.focus();
}

function setUserChip(username) {
  userNameLabel.textContent = username;
  userAvatarLabel.textContent = String(username).slice(0, 1).toUpperCase();
}

authToggle.addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  authSwitchCopy.textContent = authMode === 'login' ? '还没有账号？' : '已经有账号？';
  authToggle.textContent = authMode === 'login' ? '注册一个' : '直接登录';
  authSubmit.textContent = authMode === 'login' ? '登 录' : '注 册';
  authPasswordInput.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  authError.hidden = true;
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = authUsernameInput.value.trim();
  const password = authPasswordInput.value;
  if (authMode === 'register' && !/^[A-Za-z0-9]{8,}$/.test(username)) {
    authError.textContent = '账号需为 8 位以上的字母或数字组合。';
    authError.hidden = false;
    return;
  }
  if (password.length < 6) {
    authError.textContent = '密码至少需要 6 位。';
    authError.hidden = false;
    return;
  }
  authSubmit.disabled = true;
  authSubmit.textContent = authMode === 'login' ? '登录中…' : '注册中…';
  try {
    const response = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || '操作失败，请稍后再试。');
    await bootApp(username);
  } catch (error) {
    authError.textContent = error.message;
    authError.hidden = false;
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = authMode === 'login' ? '登 录' : '注 册';
  }
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.reload();
});

async function bootApp(username) {
  appShell.hidden = true;
  authLoading.hidden = false;
  setUserChip(username);
  try {
    examDetails.clear();
    examDetailLoads.clear();
    const [sampleContent, realExamContent, mockExamContent, loadedCatalog, vocabularyContent] = await Promise.all([
      getRequiredJSON('/content/sample-content.json', '基础学习内容'),
      getRequiredJSON('/api/content/real-exams', '真题目录'),
      getRequiredJSON('/api/content/mock-exams', '模拟卷目录'),
      getRequiredJSON('/content/catalog.json', '资料目录'),
      getRequiredJSON('/content/vocabulary.json', '六级词汇')
    ]);
    content = {
      ...sampleContent,
      words: vocabularyContent.words?.length ? vocabularyContent.words : sampleContent.words,
      wordBatchSize: Number(vocabularyContent.batchSize || DEFAULT_WORD_BATCH_SIZE),
      realExams: realExamContent.exams || [],
      mockExams: mockExamContent.exams || []
    };
    catalog = loadedCatalog;
    state = await loadState();
    const recovery = recoverLocalState(username);
    activeView = VIEW_NAMES[state.lastView] ? state.lastView : 'home';
    if (state.examSession && getExamRemainingSeconds() <= 0) finishExam();
    if (state.plan) refreshPlanFromRecords();
    render();
    registerWebMcp();
    authLoading.hidden = true;
    authScreen.hidden = true;
    appShell.hidden = false;
    if (recovery.restored) await saveState('本机草稿已恢复并同步');
    else if (recovery.pending) showToast('有一份未同步草稿仍保存在本机；当前显示服务器记录。', 'warn');
    return true;
  } catch (error) {
    stateReady = false;
    showAuthScreen(error.message || '暂时无法打开学习内容，请稍后重试。');
    return false;
  }
}

async function init() {
  try {
    const response = await fetch('/api/auth/me');
    const auth = await response.json();
    if (auth.authenticated) {
      if (await bootApp(auth.username)) return;
      return;
    }
  } catch {
    // 网络异常时进入登录页
  }
  showAuthScreen();
}

init();
