// GitHub Pages temporary edition: no accounts; records stay in this browser.
const nativeFetch = window.fetch.bind(window);
const libraries = new Map();
let mediaPromise;
async function loadMedia() {
  if (!mediaPromise) mediaPromise = nativeFetch(new URL('./static-media.json', import.meta.url), { cache: 'no-cache' })
    .then(async r => { if (!r.ok) throw new Error('听力资源配置下载失败'); return r.json(); })
    .catch(error => { mediaPromise = null; throw error; });
  return mediaPromise;
}
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('cet6-public-study', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('records');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('浏览器不允许保存学习记录，请检查存储设置。'));
});
function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
async function localState(method, incoming, force = false) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', method === 'GET' ? 'readonly' : 'readwrite');
    const store = tx.objectStore('records');
    let result;
    const read = store.get('state');
    read.onsuccess = () => {
      const saved = read.result || null;
      if (method === 'GET') { result = response({ ok: true, state: saved }); return; }
      const revision = Number(saved?.dataRevision || 0);
      if (!force && incoming.dataRevision != null && Number(incoming.dataRevision) !== revision) {
        result = response({ ok: false, state: saved, revision, error: '记录已在其他页面更新，请刷新后重试。' }, 409);
        return;
      }
      const next = { ...incoming, dataRevision: revision + 1, dataUpdatedAt: new Date().toISOString() };
      store.put(next, 'state');
      result = response({ ok: true, state: next, revision: next.dataRevision, written: 1, skipped: 0 });
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('本机保存失败，请导出备份并检查浏览器存储空间。'));
  });
}
async function loadLibrary(kind) {
  if (!libraries.has(kind)) libraries.set(kind, nativeFetch(new URL(`./content/${kind}-exams.json`, import.meta.url))
    .then(async r => { if (!r.ok) throw new Error('试卷下载失败'); return r.json(); })
    .catch(error => { libraries.delete(kind); throw error; }));
  return libraries.get(kind);
}
export async function staticFetch(input, options = {}) {
  const value = String(input);
  const method = options.method || 'GET';
  if (value === '/api/state') return localState(method, method === 'GET' ? null : JSON.parse(options.body));
  if (value === '/api/account/import') {
    const backup = JSON.parse(options.body);
    if (backup.format !== 'cet6-study-desk-backup' || !backup.state?.settings || !backup.state.wordProgress || !backup.state.realExamSessions)
      return response({ ok: false, error: '备份格式不完整，未覆盖已有记录。' }, 400);
    return localState('PUT', backup.state, true);
  }
  const match = /^\/api\/content\/(real|mock)-exams(?:\/([^/]+))?$/.exec(value);
  if (match) {
    if (!match[2]) {
      const r = await nativeFetch(new URL('./static-manifests.json', import.meta.url), { cache: 'no-cache' });
      if (!r.ok) return r;
      const manifests = await r.json(); return response(manifests[match[1]]);
    }
    const library = await loadLibrary(match[1]);
    const exam = library.exams.find(x => x.id === decodeURIComponent(match[2]));
    const media = await loadMedia();
    return exam ? response({ ...exam, audio: media[exam.audio?.sourcePath] || null, ok: true }) : response({ ok: false }, 404);
  }
  if (value === '/content/catalog.json') return response({ items: [], totalFiles: 0, totalBytes: 0, summary: {}, sourceAvailable: false });
  if (value.startsWith('/content/')) return nativeFetch(new URL(`.${value}`, import.meta.url), options);
  if (value.startsWith('/api/')) return response({ ok: false, error: '临时公开版不提供账号接口。' }, 404);
  return nativeFetch(input, options);
}
