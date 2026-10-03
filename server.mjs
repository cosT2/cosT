/**
 * 六级复习工作台 —— HTTP 服务
 *
 * 数据层见 ./db.mjs：学习状态已从单个 JSON 大对象拆成规范化关系表。
 * 前端仍按「完整 state」读写（GET/PUT /api/state），本服务负责映射与鉴权。
 *
 * 除登录/注册/健康检查外，所有端点都要求已登录会话。
 */

import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_SCHEMA_VERSION,
  StateConflictError,
  openDatabase,
  readState,
  writeState,
  querySummary,
  queryWordStats,
  migrateLegacyState,
  tableExists
} from './db.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_ROOT = existsSync(path.join(ROOT, 'index.html')) ? ROOT : path.join(ROOT, 'public');
const PUBLIC_ROOT = path.resolve(process.env.CET6_PUBLIC_ROOT || DEFAULT_PUBLIC_ROOT);
const CONTENT_ROOT = path.join(ROOT, 'content');
const DATA_ROOT = path.resolve(process.env.CET6_DATA_ROOT || path.join(ROOT, 'data'));
const DB_PATH = path.join(DATA_ROOT, 'cet6.db');
const SOURCE_ROOT = path.resolve(process.env.CET6_LIBRARY_ROOT || 'D:\\BaiduNetdiskDownload\\六级');
const PORT = Number(process.env.CET6_PORT || 5173);
const HOST = process.env.CET6_HOST || '127.0.0.1';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'cet6_session';
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const AUTH_RATE_WINDOW_MS = 10 * 60 * 1000;
const AUTH_RATE_LIMIT = 12;
const authAttempts = new Map();
const contentLibraryCache = new Map();
const NON_ENGLISH_SCRIPT_RE = /[\u0370-\u052f\u0400-\u052f\u3400-\u9fff\uf900-\ufaff\ufffd]/u;
const ANSWER_LEAK_RE = /your answer on Answer Sheet|answer on Answer Sheet\s*\d|(?:答案解析|参考答案|正确答案|语义推断题|结合录音可填入|考频\s*[:：])/i;

function readingTextIsUsable(value, minLetters = 12) {
  const text = String(value || '').trim();
  const textWithoutPrintedGloss = text.replace(/[（(]\s*[\u3400-\u9fff\s]{1,24}\s*[）)]/gu, '');
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters >= minLetters
    && !NON_ENGLISH_SCRIPT_RE.test(textWithoutPrintedGloss)
    && !/\b(?:[A-Za-z]\s+){4,}[A-Za-z]\b/.test(text)
    && !ANSWER_LEAK_RE.test(text);
}

function readingPassageIsUsable(value) {
  const text = String(value || '').trim();
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const extractionGarbage = /\(\s*cid\s*:\s*\d+\s*\)|速读巧解|定位词|词汇注释|难句分析|确定词性|锁定答案|试题精解|试题精析|【(?:定位|考点)】|原文题干待核验|�|Pa\s*rt\s*IV\s+Translation/i;
  if (text.length < 80 || letters < 80
    || /\b(?:[A-Za-z]\s+){4,}[A-Za-z]\b/.test(text)
    || ANSWER_LEAK_RE.test(text)
    || extractionGarbage.test(text)
    || /\bPassage\s+(?:Two|Three|Four)\b/i.test(text)) return false;

  // Real paragraph-matching passages have widely separated A–J section labels.
  // An OCR-inserted option bank clusters at least eight short labels together.
  const labeledChoices = [...text.matchAll(/(?:^|\s)[A-O]\)\s+[A-Za-z]/g)];
  return !labeledChoices.some((choice, index) => index + 7 < labeledChoices.length
    && labeledChoices[index + 7].index - choice.index <= 500);
}

function readingOptionText(option) {
  return typeof option === 'string' ? option.trim() : String(option?.text || '').trim();
}

function readingOptionsAreUsable(question) {
  const options = Array.isArray(question.options) ? question.options : [];
  const sharedBank = options.length >= 10 || question.sharedOptionMode === 'paragraph-match';
  if (sharedBank ? (question.section === 'A' ? options.length !== 15 : options.length < 10) : options.length !== 4) return false;
  if (options.some((option) => {
    const text = readingOptionText(option);
    return !text || NON_ENGLISH_SCRIPT_RE.test(text) || ANSWER_LEAK_RE.test(text)
      || /\b(?:[A-Za-z]\s+){4,}[A-Za-z]\b/.test(text);
  })) return false;
  return true;
}

function readingGroupIsUsable(group) {
  if (group.length < 5 || group.length > 10) return false;
  const ordered = group.slice().sort((left, right) => Number(left.number) - Number(right.number));
  const numbers = ordered.map((question) => Number(question.number));
  if (numbers.some((number, index) => index > 0 && number !== numbers[index - 1] + 1)) return false;
  if (!ordered.every((question) => {
    const stem = String(question.stem || question.prompt || '').trim();
    return question.canonicalStatus !== '待核验占位'
      && question.canonicalStatus !== '选项待核验'
      && !question.contentQualityFlags?.length
      && readingTextIsUsable(stem)
      && readingPassageIsUsable(question.passage)
      && readingOptionsAreUsable(question);
  })) return false;

  // Cloze and paragraph-matching questions share one printed option bank.
  // A refresh must not combine choices from another passage or paper.
  const usesSharedBank = ordered.some((question) => question.options?.length >= 10
    || question.sharedOptionMode === 'paragraph-match');
  if (usesSharedBank) {
    const signatures = new Set(ordered.map((question) => JSON.stringify(
      (question.options || []).map(readingOptionText)
    )));
    if (signatures.size !== 1) return false;
  }
  return true;
}

const SUBJECTIVE_REFERENCE_LEAK = /(?:参考范文|参考译文|参考答案|正确答案|答案解析|难点注释|审题思路|词汇准备|话题词汇|写作模板|精析精译|sample\s+essay|model\s+answer|reference\s+translation)\s*[:：]?/i;

function subjectivePromptIsUsable(task) {
  const prompt = String(task?.prompt || task?.text || '').trim();
  return prompt.length >= 20 && !SUBJECTIVE_REFERENCE_LEAK.test(prompt);
}

function fullExamQuestionsAreUsable(questions) {
  return questions.length > 0 && questions.every((question) => {
    if (question.canonicalStatus === '待核验占位' || question.canonicalStatus === '选项待核验'
      || question.contentQualityFlags?.length) return false;
    const stem = String(question.stem || question.prompt || '').trim();
    const options = Array.isArray(question.options) ? question.options : [];
    if (question.type === 'listening') {
      // In CET-6 listening sections the prompt is spoken in the recording;
      // the printed interface intentionally shows only the answer choices.
      if (question.answerMode === 'text') return stem.length >= 12 && options.length === 0;
      return options.length >= 4;
    }
    if (question.answerMode === 'text') return stem.length >= 12;
    return stem.length >= 12 && options.length >= 4;
  });
}

/* ---------------- database ---------------- */

const db = openDatabase(DB_PATH);

// 老库升级：把遗留的 user_state JSON 搬进新表（幂等，已迁移的用户自动跳过）。
if (tableExists(db, 'user_state')) {
  try {
    const { migrated, failed } = migrateLegacyState(db);
    if (migrated.length) console.log(`Migrated legacy state for user ids: ${migrated.join(', ')}`);
    for (const item of failed) console.error(`Legacy state migration failed for user ${item.user_id}: ${item.error}`);
  } catch (error) {
    console.error('Legacy state migration error:', error.message);
  }
}

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

/* ---------------- auth helpers ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function isValidUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9]{8,}$/.test(username);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    try {
      jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // 恶意或损坏的 Cookie 不应让整个请求变成 500。
    }
  }
  return jar;
}

function requestAddress(req) {
  return req.socket?.remoteAddress || 'local';
}

function allowAuthRequest(req, action) {
  const key = `${requestAddress(req)}:${action}`;
  const now = Date.now();
  const recent = (authAttempts.get(key) || []).filter((timestamp) => now - timestamp < AUTH_RATE_WINDOW_MS);
  if (recent.length >= AUTH_RATE_LIMIT) {
    authAttempts.set(key, recent);
    return Math.max(1, Math.ceil((AUTH_RATE_WINDOW_MS - (now - recent[0])) / 1000));
  }
  recent.push(now);
  authAttempts.set(key, recent);
  if (authAttempts.size > 1000) {
    for (const [candidate, timestamps] of authAttempts) {
      if (!timestamps.some((timestamp) => now - timestamp < AUTH_RATE_WINDOW_MS)) authAttempts.delete(candidate);
    }
  }
  return 0;
}

function getSessionUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(`
    SELECT sessions.token, sessions.expires_at, users.id, users.username
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username, token: row.token };
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function issueSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, new Date().toISOString(), expiresAt);
  // 允许多设备登录，但限制长期闲置会话数量，避免会话表无限增长。
  db.prepare(`
    DELETE FROM sessions
    WHERE user_id = ? AND token NOT IN (
      SELECT token FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 8
    )
  `).run(userId, userId);
  setSessionCookie(res, token);
  return token;
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 新账号的初始学习设置 */
function defaultStateForSignup() {
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const today = new Date();
  return {
    settings: {
      startDate: dateKey(today),
      endDate: dateKey(new Date(today.getTime() + 42 * 86400000)),
      studyWeekdays: [1, 2, 3, 4, 5],
      minutesByDay: { 0: 0, 1: 45, 2: 45, 3: 45, 4: 45, 5: 45, 6: 60 },
      tasksByDay: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [day, {
        reading: day === 0 || day === 6 ? 0 : 1,
        listening: day === 0 || day === 6 ? 0 : 1,
        writingTranslation: 0
      }])),
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
    wordOrderSeed: 20260921,
    wordOrderVersion: 2,
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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateStatePayload(state) {
  if (!isObject(state) || !isObject(state.settings)) return '数据结构不完整';
  const settings = state.settings;
  const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateKeyPattern.test(String(settings.startDate || '')) || !dateKeyPattern.test(String(settings.endDate || ''))) {
    return '学习日期格式不正确';
  }
  if (new Date(`${settings.endDate}T00:00:00`).getTime() < new Date(`${settings.startDate}T00:00:00`).getTime()) {
    return '学习结束日期不能早于开始日期';
  }
  if (!Array.isArray(settings.studyWeekdays) || settings.studyWeekdays.some((day) => !Number.isInteger(Number(day)) || Number(day) < 0 || Number(day) > 6)) {
    return '每周学习日数据不正确';
  }
  if (!isObject(state.wordProgress) || Object.keys(state.wordProgress).length > 30000) return '单词记录数量超出允许范围';
  if (!isObject(state.realExamSessions) || Object.keys(state.realExamSessions).length > 1500) return '试卷会话数量超出允许范围';
  if (state.activity !== undefined && (!Array.isArray(state.activity) || state.activity.length > 5000)) return '学习活动记录数量超出允许范围';
  if (state.notes !== undefined && (!isObject(state.notes) || Object.keys(state.notes).length > 5000)) return '笔记数量超出允许范围';
  return null;
}

/* ---------------- http helpers ---------------- */

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.lrc': 'text/plain; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return resolved;
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.end(text);
}

function sendJSON(res, statusCode, payload) {
  sendText(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8');
}

async function serveFile(res, filePath, { cache = false, req = null } = {}) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return sendText(res, 404, 'Not found');
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    let start = 0;
    let end = info.size - 1;
    let statusCode = 200;
    const range = req?.headers?.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
      if (match) {
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
        if (!match[1] && match[2]) {
          const suffixLength = Number(match[2]);
          start = Math.max(0, info.size - suffixLength);
        }
        end = Math.min(end, info.size - 1);
        if (start > end || start >= info.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
          return res.end();
        }
        statusCode = 206;
      }
    }
    const headers = {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Cache-Control': cache ? 'private, max-age=3600' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'inline'
    };
    if (statusCode === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(statusCode, headers);
    createReadStream(filePath, { start, end }).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function readContentLibrary(fileName) {
  const filePath = safePath(CONTENT_ROOT, fileName);
  if (!filePath) throw new Error('Invalid content path');
  const info = await stat(filePath);
  const cached = contentLibraryCache.get(filePath);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.value;
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  contentLibraryCache.set(filePath, { mtimeMs: info.mtimeMs, value });
  return value;
}

function examManifest(exam) {
  const questions = Array.isArray(exam.questions) ? exam.questions : [];
  const {
    questions: _questions,
    sections: _sections,
    writing: _writing,
    translation: _translation,
    sourceFiles: _sourceFiles,
    textSource: _textSource,
    ...metadata
  } = exam;
  const readingGroups = new Map();
  for (const question of questions) {
    if (question.type !== 'reading') continue;
    const passage = String(question.passage || '').trim();
    if (passage.length < 80) continue;
    if (!readingGroups.has(passage)) readingGroups.set(passage, []);
    readingGroups.get(passage).push(question);
  }
  const readingUnits = [...readingGroups.values()].filter(readingGroupIsUsable).map((group) => {
    const ordered = group.slice().sort((left, right) => Number(left.number) - Number(right.number));
    const first = Number(ordered[0]?.number || 0);
    const last = Number(ordered.at(-1)?.number || first);
    return {
      id: `${exam.id}::reading::${first}-${last}`,
      examId: exam.id,
      mode: 'reading',
      focusId: `reading-passage-${first}`,
      label: `${exam.title} · 阅读第 ${first}${last !== first ? `–${last}` : ''} 题`,
      questionCount: ordered.length,
      questionIds: ordered.map((question) => question.id),
      questionNumbers: ordered.map((question) => Number(question.number)).filter(Number.isFinite)
    };
  });
  const listeningCount = questions.filter((question) => question.type === 'listening').length;
  const hasListeningAudio = Boolean(listeningCount && exam.audio?.url);
  const listeningUnits = hasListeningAudio ? [{
    id: `${exam.id}::listening::audio`,
    examId: exam.id,
    mode: 'listening',
    focusId: 'real-audio-panel',
    label: `${exam.title} · 听力音频`,
    questionCount: listeningCount,
    questionIds: questions.filter((question) => question.type === 'listening').map((question) => question.id),
    ...(Number(exam.audio?.audioDurationSeconds) > 0 ? { audioDurationSeconds: Number(exam.audio.audioDurationSeconds) } : {})
  }] : [];
  const writingTasks = Array.isArray(exam.writing) ? exam.writing : [];
  const translationTasks = Array.isArray(exam.translation) ? exam.translation : [];
  const writingTranslationUnits = [
    ...writingTasks.map((task, index) => ({ ...task, kind: '写作', taskKey: task.id || `${exam.id}-writing-${index + 1}` })),
    ...translationTasks.map((task, index) => ({ ...task, kind: '翻译', taskKey: task.id || `${exam.id}-translation-${index + 1}` }))
  ].filter(subjectivePromptIsUsable).map((task) => ({
    id: `${exam.id}::writing-translation::${task.taskKey}`,
    examId: exam.id,
    mode: 'writingTranslation',
    focusId: `real-subjective-${task.taskKey}`,
    taskId: task.taskKey,
    label: `${exam.title} · ${task.kind}`
  }));
  const readingQuestionIds = questions.filter((question) => question.type === 'reading').map((question) => question.id);
  const coveredReadingQuestionIds = readingUnits.flatMap((unit) => unit.questionIds);
  const readingCoverageComplete = readingQuestionIds.length > 0
    && coveredReadingQuestionIds.length === readingQuestionIds.length
    && new Set(coveredReadingQuestionIds).size === readingQuestionIds.length
    && readingQuestionIds.every((id) => coveredReadingQuestionIds.includes(id));
  const hasWritingPrompt = writingTasks.length > 0 && writingTasks.every(subjectivePromptIsUsable);
  const hasTranslationPrompt = translationTasks.length > 0 && translationTasks.every(subjectivePromptIsUsable);
  const expectedQuestionNumbers = Array.isArray(exam.expectedQuestionNumbers) ? exam.expectedQuestionNumbers.map(Number) : [];
  const actualQuestionNumbers = questions.map((question) => Number(question.number)).sort((a, b) => a - b);
  const sequenceComplete = exam.completeness === '完整题号序列'
    && expectedQuestionNumbers.length === actualQuestionNumbers.length
    && expectedQuestionNumbers.every((number, index) => number === actualQuestionNumbers[index]);
  const listeningContentAvailable = exam.officialNoListening
    || (hasListeningAudio && questions.filter((question) => question.type === 'listening').length > 0);
  const answerCoverageComplete = exam.sourceType !== '模拟练习' || (questions.length > 0 && questions.every((question) => {
    const key = String(question.answerKey || '').toUpperCase();
    const options = Array.isArray(question.options) ? question.options : [];
    const optionKeys = options.map((option, index) => String(typeof option === 'string' ? String.fromCharCode(65 + index) : option?.key || String.fromCharCode(65 + index)).toUpperCase());
    if (!/^[A-Q]$/.test(key) || !question.answerSourcePath || !optionKeys.includes(key)
      || question.answer === null || question.answer === undefined || question.answer === '') return false;
    const expectedAnswer = question.sharedOptionMode === 'paragraph-match' ? key : optionKeys.indexOf(key);
    return question.answer === expectedAnswer;
  }));
  const fullAvailable = sequenceComplete
    && readingCoverageComplete
    && hasWritingPrompt
    && hasTranslationPrompt
    && listeningContentAvailable
    && fullExamQuestionsAreUsable(questions)
    && answerCoverageComplete;
  // Practice access is deliberately independent from strict completeness acceptance.
  // Every catalogued paper with at least one extracted question can be opened;
  // fullAvailable remains the stricter content-integrity signal.
  const fullPracticeEnabled = questions.length > 0;
  const fullUnavailableReasons = [];
  if (!sequenceComplete) fullUnavailableReasons.push('题号序列不完整');
  if (!readingCoverageComplete) fullUnavailableReasons.push('阅读题组未完整配对');
  if (!hasWritingPrompt) fullUnavailableReasons.push('缺少可用写作原题');
  if (!hasTranslationPrompt) fullUnavailableReasons.push('缺少可用翻译原题');
  if (!listeningContentAvailable) fullUnavailableReasons.push('缺少配套听力');
  if (!answerCoverageComplete) fullUnavailableReasons.push('逐题答案映射未完成');
  if (!fullExamQuestionsAreUsable(questions)) fullUnavailableReasons.push('存在待补录题目');
  return {
    ...metadata,
    questionCount: Number(exam.questionCount || questions.length),
    listeningCount,
    readingCount: questions.filter((question) => question.type === 'reading').length,
    readingUnits,
    listeningUnits,
    writingTranslationUnits,
    hasListeningAudio,
    readingCoverageComplete,
    answerCoverageComplete,
    fullAvailable,
    fullPracticeEnabled,
    fullUnavailableReasons
  };
}

async function handleContentApi(req, res, pathname) {
  const match = /^\/api\/content\/(real|mock)-exams(?:\/([^/]+))?$/.exec(pathname);
  if (!match || req.method !== 'GET') return sendJSON(res, 404, { ok: false, error: 'Not found' });
  const kind = match[1];
  const fileName = `${kind}-exams.json`;
  try {
    const library = await readContentLibrary(fileName);
    if (!match[2]) {
      return sendJSON(res, 200, {
        version: library.version,
        generatedAt: library.generatedAt,
        examCount: library.examCount,
        questionCount: library.questionCount,
        audioMatchedCount: library.audioMatchedCount,
        exams: (library.exams || []).map(examManifest)
      });
    }
    const examId = decodeURIComponent(match[2]);
    const exam = (library.exams || []).find((item) => item.id === examId);
    if (!exam) return sendJSON(res, 404, { ok: false, error: '试卷不存在' });
    return sendJSON(res, 200, { ...exam, ok: true });
  } catch (error) {
    console.error(`读取${kind === 'real' ? '真题' : '模拟卷'}内容失败:`, error.message);
    return sendJSON(res, 503, { ok: false, error: '题库暂时无法读取，请稍后重试。' });
  }
}

/* ---------------- auth api ---------------- */

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const retryAfter = allowAuthRequest(req, 'register');
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return sendJSON(res, 429, { ok: false, error: '注册请求过于频繁，请稍后再试。' });
    }
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }); }
    const { username, password } = body || {};
    if (!isValidUsername(username)) return sendJSON(res, 400, { ok: false, error: '账号需为 8 位以上的字母或数字组合' });
    if (!isValidPassword(password)) return sendJSON(res, 400, { ok: false, error: '密码需为 6-128 位字符' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return sendJSON(res, 409, { ok: false, error: '该账号已被注册' });
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    try {
      const info = db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)')
        .run(username, passwordHash, salt, new Date().toISOString());
      const userId = Number(info.lastInsertRowid);
      // 新账号先落一份设置行，readState 才有内容可读；初始化失败时删除账号，避免半成品账号。
      writeState(db, userId, defaultStateForSignup());
      issueSession(res, userId);
      return sendJSON(res, 200, { ok: true, username });
    } catch (error) {
      if (String(error?.code || '').includes('SQLITE_CONSTRAINT')) {
        return sendJSON(res, 409, { ok: false, error: '该账号已被注册' });
      }
      const failedUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (failedUser) db.prepare('DELETE FROM users WHERE id = ?').run(failedUser.id);
      console.error('初始化新账号数据失败:', error);
      return sendJSON(res, 500, { ok: false, error: '账号初始化失败，未创建半成品账号。' });
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const retryAfter = allowAuthRequest(req, 'login');
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return sendJSON(res, 429, { ok: false, error: '登录尝试过于频繁，请稍后再试。' });
    }
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }); }
    const { username, password } = body || {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      return sendJSON(res, 401, { ok: false, error: '账号或密码不正确' });
    }
    const user = db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').get(String(username || ''));
    if (!user || hashPassword(String(password || ''), user.salt) !== user.password_hash) {
      return sendJSON(res, 401, { ok: false, error: '账号或密码不正确' });
    }
    issueSession(res, user.id);
    return sendJSON(res, 200, { ok: true, username: user.username });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const user = getSessionUser(req);
    if (user) db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
    clearSessionCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me') {
    const user = getSessionUser(req);
    if (!user) return sendJSON(res, 200, { authenticated: false });
    return sendJSON(res, 200, { authenticated: true, username: user.username });
  }

  return sendJSON(res, 404, { ok: false, error: 'Not found' });
}

/* ---------------- state api (auth required) ---------------- */

async function handleState(req, res, user) {
  if (req.method === 'GET') {
    let state = readState(db, user.id);
    // 老账号在迁移前就存在、或设置行缺失时自愈。
    if (!state) {
      const fallback = defaultStateForSignup();
      try {
        writeState(db, user.id, fallback);
        state = readState(db, user.id);
      } catch (error) {
        console.error('初始化缺失的账号数据失败:', error);
      }
    }
    return sendJSON(res, 200, { ok: true, state });
  }

  if (req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { ok: false, error: '数据格式错误' }); }
    const validationError = validateStatePayload(body);
    if (validationError) return sendJSON(res, 400, { ok: false, error: validationError });
    try {
      const result = writeState(db, user.id, body);
      return sendJSON(res, 200, {
        ok: true,
        written: result.written.length,
        skipped: result.skipped.length,
        revision: result.revision
      });
    } catch (error) {
      if (error instanceof StateConflictError) {
        return sendJSON(res, 409, {
          ok: false,
          code: error.code,
          error: '账户数据已在其他页面更新，请重新读取后再保存。',
          revision: error.actualRevision,
          state: readState(db, user.id)
        });
      }
      console.error('writeState failed:', error);
      return sendJSON(res, 500, { ok: false, error: '保存失败，本次更改未写入数据库。' });
    }
  }

  return sendJSON(res, 405, { ok: false, error: 'Method not allowed' });
}

/* ---------------- account api：服务端备份、恢复和账户概况 ---------------- */

async function handleAccount(req, res, user, pathname) {
  if (pathname === '/api/account' && req.method === 'GET') {
    const profile = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(user.id);
    const revision = db.prepare('SELECT revision, updated_at FROM state_revisions WHERE user_id = ?').get(user.id);
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM word_progress WHERE user_id = ?) AS tracked_words,
        (SELECT COUNT(*) FROM activity WHERE user_id = ?) AS activity_count,
        (SELECT COUNT(*) FROM exam_sessions WHERE user_id = ?) AS exam_count,
        (SELECT COUNT(*) FROM state_events WHERE user_id = ?) AS save_count
    `).get(user.id, user.id, user.id, user.id);
    return sendJSON(res, 200, {
      ok: true,
      profile: {
        username: profile?.username || user.username,
        createdAt: profile?.created_at || null,
        dataRevision: revision?.revision || 0,
        dataUpdatedAt: revision?.updated_at || null,
        counts
      }
    });
  }

  if (pathname === '/api/account/export' && req.method === 'GET') {
    const state = readState(db, user.id);
    return sendJSON(res, 200, {
      ok: true,
      format: 'cet6-study-desk-backup',
      version: 2,
      exportedAt: new Date().toISOString(),
      state
    });
  }

  if (pathname === '/api/account/import' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, MAX_STATE_BYTES)); } catch { return sendJSON(res, 400, { ok: false, error: '备份文件格式错误' }); }
    const importedState = body?.state && isObject(body.state) ? body.state : body;
    const validationError = validateStatePayload(importedState);
    if (validationError) return sendJSON(res, 400, { ok: false, error: `备份未导入：${validationError}` });
    try {
      // 导入是用户主动确认后的完整恢复操作，不要求旧版本号匹配。
      const result = writeState(db, user.id, importedState, { checkRevision: false });
      const state = readState(db, user.id);
      return sendJSON(res, 200, { ok: true, revision: result.revision, state });
    } catch (error) {
      console.error('import state failed:', error);
      return sendJSON(res, 500, { ok: false, error: '备份恢复失败，数据库未完成本次恢复。' });
    }
  }

  return sendJSON(res, 404, { ok: false, error: 'Not found' });
}

/* ---------------- reports api (auth required, 真实 SQL 聚合) ---------------- */

async function handleReports(req, res, user, pathname, requestUrl) {
  if (req.method !== 'GET') return sendJSON(res, 405, { ok: false, error: 'Method not allowed' });
  if (pathname === '/api/reports/summary') return sendJSON(res, 200, querySummary(db, user.id));
  if (pathname === '/api/reports/words') {
    const limit = Math.max(1, Math.min(500, Number(requestUrl.searchParams.get('limit')) || 50));
    return sendJSON(res, 200, queryWordStats(db, user.id, limit));
  }
  return sendJSON(res, 404, { ok: false, error: 'Not found' });
}

/* ---------------- routing ---------------- */

async function serveResource(res, requestUrl, req) {
  const encodedPath = requestUrl.pathname.slice('/resource/'.length);
  let relativePath;
  try {
    relativePath = decodeURIComponent(encodedPath).replaceAll('/', path.sep);
  } catch {
    return sendText(res, 400, 'Invalid resource path');
  }
  const filePath = safePath(SOURCE_ROOT, relativePath);
  if (!filePath) return sendText(res, 403, 'Resource path is outside the configured library');
  return serveFile(res, filePath, { req });
}

async function serveStatic(res, pathname, req) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Invalid URL');
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = safePath(PUBLIC_ROOT, relative);
  if (!filePath) return sendText(res, 403, 'Invalid path');
  return serveFile(res, filePath, { cache: pathname !== '/', req });
}

async function requestHandler(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  res.setHeader('Vary', 'Accept-Encoding');

  if (requestUrl.pathname === '/api/health') {
    let sourceAvailable = false;
    try {
      await access(SOURCE_ROOT);
      sourceAvailable = true;
    } catch {
      sourceAvailable = false;
    }
    let integrity = 'ok';
    try {
      integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown';
    } catch {
      integrity = 'failed';
    }
    return sendJSON(res, integrity === 'ok' ? 200 : 503, {
      ok: integrity === 'ok',
      host: HOST,
      port: PORT,
      sourceAvailable,
      storage: 'sqlite',
      schemaVersion: DATABASE_SCHEMA_VERSION,
      integrity,
      tables: db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().c,
      now: new Date().toISOString()
    });
  }

  if (requestUrl.pathname.startsWith('/api/auth/')) return handleAuth(req, res, requestUrl.pathname);

  const user = getSessionUser(req);

  if (requestUrl.pathname === '/api/state') {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    return handleState(req, res, user);
  }

  if (requestUrl.pathname === '/api/account' || requestUrl.pathname.startsWith('/api/account/')) {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    return handleAccount(req, res, user, requestUrl.pathname);
  }

  if (requestUrl.pathname.startsWith('/api/reports/')) {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    return handleReports(req, res, user, requestUrl.pathname, requestUrl);
  }

  if (requestUrl.pathname.startsWith('/api/content/')) {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    return handleContentApi(req, res, requestUrl.pathname);
  }

  // 以下内容（结构化题目、本地资料、媒体）都必须登录后才能访问。
  if (requestUrl.pathname.startsWith('/resource/')) {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    return serveResource(res, requestUrl, req);
  }

  if (requestUrl.pathname.startsWith('/content/')) {
    if (!user) return sendJSON(res, 401, { ok: false, error: '请先登录' });
    const relative = requestUrl.pathname.slice('/content/'.length);
    const filePath = safePath(CONTENT_ROOT, relative);
    if (!filePath) return sendText(res, 403, 'Invalid content path');
    return serveFile(res, filePath, { cache: false, req });
  }

  return serveStatic(res, requestUrl.pathname, req);
}

const server = http.createServer((req, res) => {
  requestHandler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.end();
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在关闭 HTTP 服务并保存 SQLite WAL。`);
  server.close(() => {
    try { db.close(); } finally { process.exit(0); }
  });
  setTimeout(() => {
    try { db.close(); } finally { process.exit(1); }
  }, 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。若网站已经启动，可以直接打开 http://${HOST}:${PORT}/。`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`CET6 Study Desk running at http://${HOST}:${PORT}/`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Resource library: ${SOURCE_ROOT}`);
});
