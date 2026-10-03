/**
 * 六级复习工作台 —— 数据访问层
 *
 * 设计目标：把原来存在 user_state.data 里的单个 JSON 大对象，拆成规范化关系表。
 * 前端仍然用「完整 state 对象」读写（/api/state），本模块负责在两者之间做无损映射：
 *   - readState(userId)    : 从各表聚合出前端期望的 state 结构
 *   - writeState(userId, s): 把 state 差异写回各表（只动变化的行）
 *
 * 迁移安全：user_state 作为历史备份保留，迁移后不再写入。
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const DATABASE_SCHEMA_VERSION = 2;

export class StateConflictError extends Error {
  constructor(expectedRevision, actualRevision) {
    super('账户数据已在其他页面更新');
    this.name = 'StateConflictError';
    this.code = 'STATE_CONFLICT';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/* ------------------------------------------------------------------ *
 *  schema
 * ------------------------------------------------------------------ */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    created_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  /* 数据库版本和运行状态，便于升级、诊断与恢复 */
  CREATE TABLE IF NOT EXISTS database_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  /* 每次成功写入的单调递增版本，防止多标签页覆盖新数据 */
  CREATE TABLE IF NOT EXISTS state_revisions (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  /* 轻量保存审计：只保存变更表和哈希，不保存密码或完整学习内容 */
  CREATE TABLE IF NOT EXISTS state_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision       INTEGER NOT NULL,
    changed_tables TEXT NOT NULL,
    state_hash     TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_state_events_user ON state_events(user_id, id DESC);

  /* 学习计划设置：每个用户一行 */
  CREATE TABLE IF NOT EXISTS settings (
    user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    start_date           TEXT    NOT NULL,
    end_date             TEXT    NOT NULL,
    study_weekdays       TEXT    NOT NULL,
    minutes_by_day       TEXT    NOT NULL,
    tasks_by_day         TEXT    NOT NULL,
    special_dates        TEXT    NOT NULL,
    plan_mode            TEXT    NOT NULL DEFAULT 'time',
    vocabulary_coverage  INTEGER NOT NULL DEFAULT 80,
    simulation_count     INTEGER NOT NULL DEFAULT 1,
    known_words          INTEGER NOT NULL DEFAULT 0,
    focus                TEXT    NOT NULL,
    buffer_percent       INTEGER NOT NULL DEFAULT 15,
    exam_date            TEXT    NOT NULL DEFAULT '',
    updated_at           TEXT    NOT NULL
  );

  /* 学习进度计数器 */
  CREATE TABLE IF NOT EXISTS study_progress (
    user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    word_batch         INTEGER NOT NULL DEFAULT 0,
    word_order_seed    INTEGER NOT NULL DEFAULT 0,
    word_order_version INTEGER NOT NULL DEFAULT 0,
    last_view          TEXT    NOT NULL DEFAULT 'home',
    imported_at        TEXT,
    updated_at         TEXT    NOT NULL
  );

  /* 单词掌握情况：每词一行，可查询 */
  CREATE TABLE IF NOT EXISTS word_progress (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    word_id     TEXT    NOT NULL,
    stage       INTEGER NOT NULL DEFAULT 0,
    seen_count  INTEGER NOT NULL DEFAULT 0,
    mastered    INTEGER NOT NULL DEFAULT 0,
    favorite    INTEGER NOT NULL DEFAULT 0,
    last_rating TEXT,
    next_review TEXT,
    last_seen   TEXT,
    PRIMARY KEY (user_id, word_id)
  );

  CREATE INDEX IF NOT EXISTS idx_word_progress_mastered ON word_progress(user_id, mastered);

  /* 笔记 / 复盘记录 */
  CREATE TABLE IF NOT EXISTS notes (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_key   TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, note_key)
  );

  /* 学习活动流水 */
  CREATE TABLE IF NOT EXISTS activity (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id            TEXT    NOT NULL,
    activity_date TEXT    NOT NULL,
    label         TEXT    NOT NULL,
    minutes       INTEGER NOT NULL DEFAULT 0,
    activity_type TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_date ON activity(user_id, activity_date);

  /* 整套模拟 / 听力 / 阅读会话 */
  CREATE TABLE IF NOT EXISTS exam_sessions (
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id                 TEXT    NOT NULL,
    started_at              INTEGER NOT NULL DEFAULT 0,
    listening_ended_at      TEXT,
    listening_window_ends_at INTEGER,
    last_saved_at           TEXT,
    submitted_at            TEXT,
    PRIMARY KEY (user_id, exam_id)
  );

  /* 逐题作答：真题模拟 */
  CREATE TABLE IF NOT EXISTS exam_answers (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id     TEXT    NOT NULL,
    question_id TEXT    NOT NULL,
    answer_kind TEXT    NOT NULL,
    answer      TEXT    NOT NULL,
    PRIMARY KEY (user_id, exam_id, question_id, answer_kind)
  );

  CREATE INDEX IF NOT EXISTS idx_exam_answers_question ON exam_answers(question_id);

  /* 练习场答题记录 */
  CREATE TABLE IF NOT EXISTS question_results (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT    NOT NULL,
    selected    TEXT,
    correct     INTEGER,
    answered_at TEXT,
    PRIMARY KEY (user_id, question_id)
  );

  /* 语法单元完成状态 */
  CREATE TABLE IF NOT EXISTS grammar_progress (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unit_id    TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL,
    PRIMARY KEY (user_id, unit_id)
  );

  /* 应用过的计划版本 */
  CREATE TABLE IF NOT EXISTS plan_history (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id               TEXT    NOT NULL,
    applied_at       TEXT,
    plan_mode        TEXT,
    start_date       TEXT,
    end_date         TEXT,
    active_days      INTEGER NOT NULL DEFAULT 0,
    available_minutes INTEGER NOT NULL DEFAULT 0,
    expected_minutes INTEGER NOT NULL DEFAULT 0,
    gap_minutes      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );

  /* 当前生成的日历计划（派生缓存，重算即可再生） */
  CREATE TABLE IF NOT EXISTS plan_snapshots (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generated_at TEXT,
    data         TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );

  /* 最近一次交卷结果 */
  CREATE TABLE IF NOT EXISTS exam_results (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    exam_id         TEXT,
    title           TEXT,
    correct         INTEGER NOT NULL DEFAULT 0,
    known_total     INTEGER NOT NULL DEFAULT 0,
    answered        INTEGER NOT NULL DEFAULT 0,
    total           INTEGER NOT NULL DEFAULT 0,
    elapsed_minutes INTEGER NOT NULL DEFAULT 0,
    completed_at    TEXT
  );

  /* 表级内容指纹：state 未变则整表跳过，避免每次按键全量重写 */
  CREATE TABLE IF NOT EXISTS user_sync_meta (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    table_key TEXT    NOT NULL,
    hash      TEXT    NOT NULL,
    PRIMARY KEY (user_id, table_key)
  );
`;

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

const nowISO = () => new Date().toISOString();

function toJSON(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

function parseJSON(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function parseExamSessionKey(storageKey) {
  const value = String(storageKey || '');
  const parts = value.split('::');
  if (parts.length > 1 && ['full', 'reading', 'listening', 'writingTranslation'].includes(parts[1])) {
    return { examId: parts[0], mode: parts[1] };
  }
  // 旧版把整套、阅读和听力的答案混存在试卷编号下。保留原答案到整套会话。
  return { examId: value, mode: 'full' };
}

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function toBoolInt(value) {
  return value ? 1 : 0;
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function toNullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text === '' ? null : text;
}

/** 稳定序列化：对象键排序，保证同内容得到同指纹 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** 用内容指纹判断某张表是否需要重写 */
function tableHash(rows) {
  return stableStringify(rows);
}

/* ------------------------------------------------------------------ *
 * 默认 state（与前端 createDefaultState 对齐，用于补齐缺省值）
 * ------------------------------------------------------------------ */

const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6];

const DEFAULT_TASKS_BY_DAY = Object.fromEntries(DAY_KEYS.map((day) => [
  day,
  { reading: day === 0 || day === 6 ? 0 : 1, listening: day === 0 || day === 6 ? 0 : 1, writingTranslation: 0 }
]));

const DEFAULT_MINUTES_BY_DAY = { 0: 0, 1: 45, 2: 45, 3: 45, 4: 45, 5: 45, 6: 60 };

/* ------------------------------------------------------------------ *
 * database open + schema
 * ------------------------------------------------------------------ */

export function openDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const stamp = nowISO();
  db.prepare(`
    INSERT INTO database_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(DATABASE_SCHEMA_VERSION), stamp);
  // 为升级前已经存在的账号补齐初始版本号。该操作幂等，不改写任何学习内容，
  // 让旧的浏览器状态也能参与后续的并发冲突保护。
  db.exec(`
    INSERT INTO state_revisions (user_id, revision, updated_at)
    SELECT settings.user_id, 1, settings.updated_at
    FROM settings
    WHERE NOT EXISTS (
      SELECT 1 FROM state_revisions
      WHERE state_revisions.user_id = settings.user_id
    )
  `);
  return db;
}

/* ------------------------------------------------------------------ *
 * read: 各表聚合 → 前端 state
 * ------------------------------------------------------------------ */

export function readState(db, userId) {
  const settingsRow = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
  if (!settingsRow) return null;

  const progressRow = db.prepare('SELECT * FROM study_progress WHERE user_id = ?').get(userId);
  const planRow = db.prepare('SELECT data FROM plan_snapshots WHERE user_id = ?').get(userId);
  const resultRow = db.prepare('SELECT * FROM exam_results WHERE user_id = ?').get(userId);
  const revisionRow = db.prepare('SELECT revision, updated_at FROM state_revisions WHERE user_id = ?').get(userId);

  const wordProgress = {};
  for (const row of db.prepare('SELECT * FROM word_progress WHERE user_id = ?').all(userId)) {
    const entry = {
      stage: row.stage,
      nextReview: row.next_review,
      seenCount: row.seen_count,
      lastRating: row.last_rating,
      favorite: Boolean(row.favorite),
      mastered: Boolean(row.mastered)
    };
    if (row.last_seen) entry.lastSeen = row.last_seen;
    wordProgress[row.word_id] = entry;
  }

  const notes = {};
  for (const row of db.prepare('SELECT note_key, content FROM notes WHERE user_id = ?').all(userId)) {
    notes[row.note_key] = row.content;
  }

  const grammarDone = {};
  for (const row of db.prepare('SELECT unit_id, done FROM grammar_progress WHERE user_id = ?').all(userId)) {
    grammarDone[row.unit_id] = Boolean(row.done);
  }

  const practiceResults = {};
  for (const row of db.prepare('SELECT * FROM question_results WHERE user_id = ?').all(userId)) {
    practiceResults[row.question_id] = {
      selected: row.selected,
      correct: row.correct === null ? null : Boolean(row.correct),
      completed: true,
      answeredAt: row.answered_at
    };
  }

  const activity = db.prepare(`
    SELECT id, activity_date, label, minutes, activity_type
    FROM activity WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId).map((row) => ({
    id: row.id,
    date: row.activity_date,
    label: row.label,
    minutes: row.minutes,
    type: row.activity_type
  }));

  const planHistory = db.prepare(`
    SELECT * FROM plan_history WHERE user_id = ?
    ORDER BY id DESC
  `).all(userId).map((row) => ({
    id: row.id,
    appliedAt: row.applied_at,
    mode: row.plan_mode,
    startDate: row.start_date,
    endDate: row.end_date,
    activeDays: row.active_days,
    availableMinutes: row.available_minutes,
    expectedMinutes: row.expected_minutes,
    gapMinutes: row.gap_minutes
  }));

  // 会话 + 逐题作答
  const answersByExam = new Map();
  for (const row of db.prepare('SELECT * FROM exam_answers WHERE user_id = ?').all(userId)) {
    if (!answersByExam.has(row.exam_id)) answersByExam.set(row.exam_id, { choice: {}, text: {} });
    const bucket = answersByExam.get(row.exam_id);
    if (row.answer_kind === 'choice') bucket.choice[row.question_id] = row.answer;
    else bucket.text[row.question_id] = row.answer;
  }

  const realExamSessions = {};
  for (const row of db.prepare('SELECT * FROM exam_sessions WHERE user_id = ?').all(userId)) {
    const bucket = answersByExam.get(row.exam_id) || { choice: {}, text: {} };
    const { examId, mode } = parseExamSessionKey(row.exam_id);
    realExamSessions[row.exam_id] = {
      examId,
      mode,
      startedAt: row.started_at,
      answers: bucket.choice,
      textAnswers: bucket.text,
      listeningEndedAt: row.listening_ended_at,
      listeningWindowEndsAt: row.listening_window_ends_at,
      lastSavedAt: row.last_saved_at,
      ...(row.submitted_at ? { submittedAt: row.submitted_at } : {})
    };
  }

  return {
    version: 1,
    appVersion: '0.1.0',
    settings: {
      startDate: settingsRow.start_date,
      endDate: settingsRow.end_date,
      studyWeekdays: parseJSON(settingsRow.study_weekdays, []),
      minutesByDay: parseJSON(settingsRow.minutes_by_day, DEFAULT_MINUTES_BY_DAY),
      tasksByDay: parseJSON(settingsRow.tasks_by_day, DEFAULT_TASKS_BY_DAY),
      specialDates: parseJSON(settingsRow.special_dates, {}),
      mode: settingsRow.plan_mode,
      targets: {
        vocabularyCoverage: settingsRow.vocabulary_coverage,
        simulationCount: settingsRow.simulation_count
      },
      base: { knownWords: settingsRow.known_words },
      focus: parseJSON(settingsRow.focus, []),
      bufferPercent: settingsRow.buffer_percent,
      examDate: settingsRow.exam_date
    },
    plan: planRow ? parseJSON(planRow.data, null) : null,
    planHistory,
    wordBatch: progressRow ? progressRow.word_batch : 0,
    wordOrderSeed: progressRow ? progressRow.word_order_seed : 0,
    wordOrderVersion: progressRow ? progressRow.word_order_version : 0,
    wordProgress,
    practiceResults,
    grammarDone,
    notes,
    activity,
    examSession: null,
    realExamSessions,
    lastExamResult: resultRow ? {
      examId: resultRow.exam_id,
      title: resultRow.title,
      correct: resultRow.correct,
      knownTotal: resultRow.known_total,
      answered: resultRow.answered,
      total: resultRow.total,
      elapsedMinutes: resultRow.elapsed_minutes,
      completedAt: resultRow.completed_at
    } : null,
    importedAt: progressRow ? progressRow.imported_at : null,
    lastView: progressRow ? progressRow.last_view : 'home',
    dataRevision: revisionRow ? revisionRow.revision : 0,
    dataUpdatedAt: revisionRow ? revisionRow.updated_at : null
  };
}

/* ------------------------------------------------------------------ *
 * write: state → 各表（按指纹跳过未变化表）
 * ------------------------------------------------------------------ */

function replaceTable(db, userId, key, rows, writer) {
  const hash = tableHash(rows);
  const meta = db.prepare('SELECT hash FROM user_sync_meta WHERE user_id = ? AND table_key = ?').get(userId, key);
  if (meta && meta.hash === hash) return false;
  writer();
  db.prepare(`
    INSERT INTO user_sync_meta (user_id, table_key, hash) VALUES (?, ?, ?)
    ON CONFLICT(user_id, table_key) DO UPDATE SET hash = excluded.hash
  `).run(userId, key, hash);
  return true;
}

/**
 * 把完整 state 写入各表。
 * @returns {{written: string[], skipped: string[]}}
 */
export function writeState(db, userId, state, { checkRevision = true } = {}) {
  const written = [];
  const skipped = [];
  const stamp = nowISO();
  const settings = state.settings || {};

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRevisionRow = db.prepare('SELECT revision FROM state_revisions WHERE user_id = ?').get(userId);
    const currentRevision = currentRevisionRow ? toInt(currentRevisionRow.revision, 0) : 0;
    const suppliedRevision = state.dataRevision === undefined || state.dataRevision === null || state.dataRevision === ''
      ? null
      : toInt(state.dataRevision, -1);
    if (checkRevision && suppliedRevision !== null && suppliedRevision !== currentRevision) {
      throw new StateConflictError(suppliedRevision, currentRevision);
    }
    /* --- settings --- */
    const settingsFingerprint = {
      start_date: String(settings.startDate || ''),
      end_date: String(settings.endDate || ''),
      study_weekdays: settings.studyWeekdays || [],
      minutes_by_day: settings.minutesByDay || {},
      tasks_by_day: settings.tasksByDay || {},
      special_dates: settings.specialDates || {},
      plan_mode: String(settings.mode || 'time'),
      vocabulary_coverage: toInt(settings.targets?.vocabularyCoverage, 80),
      simulation_count: toInt(settings.targets?.simulationCount, 1),
      known_words: toInt(settings.base?.knownWords, 0),
      focus: settings.focus || [],
      buffer_percent: toInt(settings.bufferPercent, 15),
      exam_date: String(settings.examDate || '')
    };
    replaceTable(db, userId, 'settings', settingsFingerprint, () => {
      db.prepare(`
        INSERT INTO settings (
          user_id, start_date, end_date, study_weekdays, minutes_by_day, tasks_by_day,
          special_dates, plan_mode, vocabulary_coverage, simulation_count, known_words,
          focus, buffer_percent, exam_date, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          start_date = excluded.start_date, end_date = excluded.end_date,
          study_weekdays = excluded.study_weekdays, minutes_by_day = excluded.minutes_by_day,
          tasks_by_day = excluded.tasks_by_day, special_dates = excluded.special_dates,
          plan_mode = excluded.plan_mode, vocabulary_coverage = excluded.vocabulary_coverage,
          simulation_count = excluded.simulation_count, known_words = excluded.known_words,
          focus = excluded.focus, buffer_percent = excluded.buffer_percent,
          exam_date = excluded.exam_date, updated_at = excluded.updated_at
      `).run(
        userId, settingsFingerprint.start_date, settingsFingerprint.end_date,
        toJSON(settingsFingerprint.study_weekdays, []), toJSON(settingsFingerprint.minutes_by_day, {}),
        toJSON(settingsFingerprint.tasks_by_day, {}), toJSON(settingsFingerprint.special_dates, {}),
        settingsFingerprint.plan_mode, settingsFingerprint.vocabulary_coverage,
        settingsFingerprint.simulation_count, settingsFingerprint.known_words,
        toJSON(settingsFingerprint.focus, []), settingsFingerprint.buffer_percent,
        settingsFingerprint.exam_date, stamp
      );
    }) ? written.push('settings') : skipped.push('settings');

    /* --- study_progress --- */
    const progressFingerprint = {
      word_batch: toInt(state.wordBatch, 0),
      word_order_seed: toInt(state.wordOrderSeed, 0),
      word_order_version: toInt(state.wordOrderVersion, 0),
      last_view: String(state.lastView || 'home'),
      imported_at: state.importedAt ? String(state.importedAt) : null
    };
    replaceTable(db, userId, 'study_progress', progressFingerprint, () => {
      db.prepare(`
        INSERT INTO study_progress (
          user_id, word_batch, word_order_seed, word_order_version, last_view, imported_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          word_batch = excluded.word_batch, word_order_seed = excluded.word_order_seed,
          word_order_version = excluded.word_order_version, last_view = excluded.last_view,
          imported_at = excluded.imported_at, updated_at = excluded.updated_at
      `).run(
        userId, progressFingerprint.word_batch, progressFingerprint.word_order_seed,
        progressFingerprint.word_order_version, progressFingerprint.last_view,
        progressFingerprint.imported_at, stamp
      );
    }) ? written.push('study_progress') : skipped.push('study_progress');

    /* --- word_progress --- */
    const wordRows = Object.entries(state.wordProgress || {}).map(([wordId, entry]) => ({
      word_id: wordId,
      stage: toInt(entry?.stage, 0),
      seen_count: toInt(entry?.seenCount, 0),
      mastered: toBoolInt(entry?.mastered),
      favorite: toBoolInt(entry?.favorite),
      last_rating: toNullableText(entry?.lastRating),
      next_review: toNullableText(entry?.nextReview),
      last_seen: toNullableText(entry?.lastSeen)
    })).sort((left, right) => left.word_id.localeCompare(right.word_id));

    replaceTable(db, userId, 'word_progress', wordRows, () => {
      db.prepare('DELETE FROM word_progress WHERE user_id = ?').run(userId);
      const insert = db.prepare(`
        INSERT INTO word_progress (
          user_id, word_id, stage, seen_count, mastered, favorite, last_rating, next_review, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of wordRows) {
        insert.run(userId, row.word_id, row.stage, row.seen_count, row.mastered, row.favorite, row.last_rating, row.next_review, row.last_seen);
      }
    }) ? written.push('word_progress') : skipped.push('word_progress');

    /* --- notes --- */
    const noteRows = Object.entries(state.notes || {}).map(([key, value]) => ({
      note_key: key,
      content: String(value ?? '')
    })).sort((left, right) => left.note_key.localeCompare(right.note_key));

    replaceTable(db, userId, 'notes', noteRows, () => {
      db.prepare('DELETE FROM notes WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT INTO notes (user_id, note_key, content, updated_at) VALUES (?, ?, ?, ?)');
      for (const row of noteRows) insert.run(userId, row.note_key, row.content, stamp);
    }) ? written.push('notes') : skipped.push('notes');

    /* --- grammar_progress --- */
    const grammarRows = Object.entries(state.grammarDone || {}).map(([unitId, done]) => ({
      unit_id: unitId,
      done: toBoolInt(done)
    })).sort((left, right) => left.unit_id.localeCompare(right.unit_id));

    replaceTable(db, userId, 'grammar_progress', grammarRows, () => {
      db.prepare('DELETE FROM grammar_progress WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT INTO grammar_progress (user_id, unit_id, done, updated_at) VALUES (?, ?, ?, ?)');
      for (const row of grammarRows) insert.run(userId, row.unit_id, row.done, stamp);
    }) ? written.push('grammar_progress') : skipped.push('grammar_progress');

    /* --- question_results --- */
    const practiceRows = Object.entries(state.practiceResults || {}).map(([questionId, entry]) => ({
      question_id: questionId,
      selected: entry?.selected === undefined || entry?.selected === null ? null : String(entry.selected),
      correct: entry?.correct === null || entry?.correct === undefined ? null : toBoolInt(entry.correct),
      answered_at: toNullableText(entry?.answeredAt)
    })).sort((left, right) => left.question_id.localeCompare(right.question_id));

    replaceTable(db, userId, 'question_results', practiceRows, () => {
      db.prepare('DELETE FROM question_results WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT INTO question_results (user_id, question_id, selected, correct, answered_at) VALUES (?, ?, ?, ?, ?)');
      for (const row of practiceRows) insert.run(userId, row.question_id, row.selected, row.correct, row.answered_at);
    }) ? written.push('question_results') : skipped.push('question_results');

    /* --- activity --- */
    const activityRows = (Array.isArray(state.activity) ? state.activity : []).map((item) => ({
      id: String(item?.id ?? ''),
      activity_date: String(item?.date ?? ''),
      label: String(item?.label ?? ''),
      minutes: toInt(item?.minutes, 0),
      activity_type: String(item?.type ?? '')
    })).filter((row) => row.id !== '').sort((left, right) => left.id.localeCompare(right.id));

    replaceTable(db, userId, 'activity', activityRows, () => {
      db.prepare('DELETE FROM activity WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT INTO activity (user_id, id, activity_date, label, minutes, activity_type) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of activityRows) insert.run(userId, row.id, row.activity_date, row.label, row.minutes, row.activity_type);
    }) ? written.push('activity') : skipped.push('activity');

    /* --- plan_history --- */
    const planHistoryRows = (Array.isArray(state.planHistory) ? state.planHistory : []).map((item) => ({
      id: String(item?.id ?? ''),
      applied_at: toNullableText(item?.appliedAt),
      plan_mode: toNullableText(item?.mode),
      start_date: toNullableText(item?.startDate),
      end_date: toNullableText(item?.endDate),
      active_days: toInt(item?.activeDays, 0),
      available_minutes: toInt(item?.availableMinutes, 0),
      expected_minutes: toInt(item?.expectedMinutes, 0),
      gap_minutes: toInt(item?.gapMinutes, 0)
    })).filter((row) => row.id !== '').sort((left, right) => left.id.localeCompare(right.id));

    replaceTable(db, userId, 'plan_history', planHistoryRows, () => {
      db.prepare('DELETE FROM plan_history WHERE user_id = ?').run(userId);
      const insert = db.prepare(`
        INSERT INTO plan_history (
          user_id, id, applied_at, plan_mode, start_date, end_date,
          active_days, available_minutes, expected_minutes, gap_minutes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of planHistoryRows) {
        insert.run(userId, row.id, row.applied_at, row.plan_mode, row.start_date, row.end_date,
          row.active_days, row.available_minutes, row.expected_minutes, row.gap_minutes);
      }
    }) ? written.push('plan_history') : skipped.push('plan_history');

    /* --- exam_sessions + exam_answers --- */
    const sessionRows = [];
    const answerRows = [];
    for (const [examId, session] of Object.entries(state.realExamSessions || {})) {
      sessionRows.push({
        exam_id: examId,
        started_at: toInt(session?.startedAt, 0),
        listening_ended_at: toNullableText(session?.listeningEndedAt),
        listening_window_ends_at: toNullableInt(session?.listeningWindowEndsAt),
        last_saved_at: toNullableText(session?.lastSavedAt),
        submitted_at: toNullableText(session?.submittedAt)
      });
      for (const [questionId, answer] of Object.entries(session?.answers || {})) {
        if (answer === null || answer === undefined || answer === '') continue;
        answerRows.push({ exam_id: examId, question_id: questionId, answer_kind: 'choice', answer: String(answer) });
      }
      for (const [questionId, text] of Object.entries(session?.textAnswers || {})) {
        if (text === null || text === undefined) continue;
        answerRows.push({ exam_id: examId, question_id: questionId, answer_kind: 'text', answer: String(text) });
      }
    }
    sessionRows.sort((left, right) => left.exam_id.localeCompare(right.exam_id));
    answerRows.sort((left, right) => (left.exam_id + left.question_id + left.answer_kind).localeCompare(right.exam_id + right.question_id + right.answer_kind));

    replaceTable(db, userId, 'exam_sessions', sessionRows, () => {
      db.prepare('DELETE FROM exam_sessions WHERE user_id = ?').run(userId);
      const insert = db.prepare(`
        INSERT INTO exam_sessions (
          user_id, exam_id, started_at, listening_ended_at, listening_window_ends_at, last_saved_at, submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of sessionRows) {
        insert.run(userId, row.exam_id, row.started_at, row.listening_ended_at,
          row.listening_window_ends_at, row.last_saved_at, row.submitted_at);
      }
    }) ? written.push('exam_sessions') : skipped.push('exam_sessions');

    replaceTable(db, userId, 'exam_answers', answerRows, () => {
      db.prepare('DELETE FROM exam_answers WHERE user_id = ?').run(userId);
      const insert = db.prepare('INSERT INTO exam_answers (user_id, exam_id, question_id, answer_kind, answer) VALUES (?, ?, ?, ?, ?)');
      for (const row of answerRows) insert.run(userId, row.exam_id, row.question_id, row.answer_kind, row.answer);
    }) ? written.push('exam_answers') : skipped.push('exam_answers');

    /* --- plan_snapshots --- */
    const planPayload = state.plan ? stableStringify(state.plan) : null;
    replaceTable(db, userId, 'plan_snapshots', { plan: planPayload }, () => {
      if (planPayload === null) {
        db.prepare('DELETE FROM plan_snapshots WHERE user_id = ?').run(userId);
      } else {
        db.prepare(`
          INSERT INTO plan_snapshots (user_id, generated_at, data, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            generated_at = excluded.generated_at, data = excluded.data, updated_at = excluded.updated_at
        `).run(userId, toNullableText(state.plan?.generatedAt), JSON.stringify(state.plan), stamp);
      }
    }) ? written.push('plan_snapshots') : skipped.push('plan_snapshots');

    /* --- exam_results --- */
    const last = state.lastExamResult;
    const lastFingerprint = last ? {
      exam_id: toNullableText(last.examId),
      title: toNullableText(last.title),
      correct: toInt(last.correct, 0),
      known_total: toInt(last.knownTotal, 0),
      answered: toInt(last.answered, 0),
      total: toInt(last.total, 0),
      elapsed_minutes: toInt(last.elapsedMinutes, 0),
      completed_at: toNullableText(last.completedAt)
    } : null;

    replaceTable(db, userId, 'exam_results', { last: lastFingerprint }, () => {
      if (!lastFingerprint) {
        db.prepare('DELETE FROM exam_results WHERE user_id = ?').run(userId);
      } else {
        db.prepare(`
          INSERT INTO exam_results (
            user_id, exam_id, title, correct, known_total, answered, total, elapsed_minutes, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            exam_id = excluded.exam_id, title = excluded.title, correct = excluded.correct,
            known_total = excluded.known_total, answered = excluded.answered, total = excluded.total,
            elapsed_minutes = excluded.elapsed_minutes, completed_at = excluded.completed_at
        `).run(userId, lastFingerprint.exam_id, lastFingerprint.title, lastFingerprint.correct,
          lastFingerprint.known_total, lastFingerprint.answered, lastFingerprint.total,
          lastFingerprint.elapsed_minutes, lastFingerprint.completed_at);
      }
    }) ? written.push('exam_results') : skipped.push('exam_results');

    let revision = currentRevision;
    if (written.length) {
      revision += 1;
      db.prepare(`
        INSERT INTO state_revisions (user_id, revision, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
      `).run(userId, revision, stamp);
      const stateHash = crypto.createHash('sha256').update(stableStringify(state)).digest('hex');
      db.prepare(`
        INSERT INTO state_events (user_id, revision, changed_tables, state_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, revision, written.join(','), stateHash, stamp);
      // 保存审计保留最近 500 次，避免高频自动保存无限增长。
      db.prepare(`
        DELETE FROM state_events
        WHERE user_id = ? AND id NOT IN (
          SELECT id FROM state_events WHERE user_id = ? ORDER BY id DESC LIMIT 500
        )
      `).run(userId, userId);
    }

    db.exec('COMMIT');
    return { written, skipped, revision };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 查询 API：真实 SQL 聚合（前端的"演示数据"由此替换）
 * ------------------------------------------------------------------ */

export function querySummary(db, userId) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(minutes), 0)                          AS total_minutes,
      COUNT(*)                                           AS activity_count,
      COUNT(DISTINCT activity_date)                      AS active_days,
      MIN(activity_date)                                 AS first_date,
      MAX(activity_date)                                 AS last_date
    FROM activity WHERE user_id = ?
  `).get(userId);

  const byType = db.prepare(`
    SELECT activity_type AS type, SUM(minutes) AS minutes, COUNT(*) AS count
    FROM activity WHERE user_id = ?
    GROUP BY activity_type ORDER BY minutes DESC
  `).all(userId);

  const daily = db.prepare(`
    SELECT activity_date AS date, SUM(minutes) AS minutes, COUNT(*) AS count
    FROM activity WHERE user_id = ?
    GROUP BY activity_date ORDER BY activity_date DESC LIMIT 30
  `).all(userId);

  const words = db.prepare(`
    SELECT
      COUNT(*)                                  AS tracked,
      SUM(CASE WHEN seen_count > 0 THEN 1 ELSE 0 END) AS seen,
      SUM(CASE WHEN mastered = 1 THEN 1 ELSE 0 END)   AS mastered,
      SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END)   AS favorited,
      SUM(CASE WHEN mastered = 0 AND seen_count > 0 AND (next_review IS NULL OR next_review <= date('now','localtime')) THEN 1 ELSE 0 END) AS due
    FROM word_progress WHERE user_id = ?
  `).get(userId);

  const exams = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE
        WHEN instr(s.exam_id, '::') > 0 THEN substr(s.exam_id, 1, instr(s.exam_id, '::') - 1)
        ELSE s.exam_id END)                                            AS exams_touched,
      COUNT(a.question_id)                                             AS answers_saved,
      SUM(CASE WHEN a.answer_kind = 'text' THEN 1 ELSE 0 END)          AS text_answers
    FROM exam_sessions s
    LEFT JOIN exam_answers a ON a.user_id = s.user_id AND a.exam_id = s.exam_id
    WHERE s.user_id = ?
  `).get(userId);

  const lastResult = db.prepare('SELECT * FROM exam_results WHERE user_id = ?').get(userId);

  return {
    ok: true,
    activity: { ...totals, byType, daily },
    words,
    exams: { ...exams, lastResult: lastResult || null },
    generatedAt: nowISO()
  };
}

export function queryWordStats(db, userId, limit = 50) {
  const rows = db.prepare(`
    SELECT word_id, stage, seen_count, mastered, favorite, last_rating, next_review, last_seen
    FROM word_progress WHERE user_id = ?
    ORDER BY seen_count DESC, word_id ASC LIMIT ?
  `).all(userId, toInt(limit, 50));
  return { ok: true, words: rows, generatedAt: nowISO() };
}

export function migrateLegacyState(db) {
  const legacyRows = db.prepare('SELECT user_id, data FROM user_state').all();
  const migrated = [];
  const failed = [];
  for (const row of legacyRows) {
    const existing = db.prepare('SELECT user_id FROM settings WHERE user_id = ?').get(row.user_id);
    if (existing) continue;
    try {
      const parsed = JSON.parse(row.data);
      writeState(db, row.user_id, parsed);
      migrated.push(row.user_id);
    } catch (error) {
      failed.push({ user_id: row.user_id, error: error.message });
    }
  }
  return { migrated, failed };
}

export function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
