import { put, get } from '@vercel/blob';
/* Vercel Blob 자격 찾기
   Storage 를 연결할 때 접두사가 붙으면(`housing_STORE_ID`, `procurement_STORE_ID` …)
   기본 이름(BLOB_READ_WRITE_TOKEN)이 없어서 SDK 가 엉뚱한 자격으로 붙고 403 이 납니다.
   그래서 기본 이름 → 접두사가 뭐든 끝이 맞는 이름 순으로 찾아 명시적으로 넘깁니다. */
const BLOB_OPT = (() => {
  const pick = (suffix) => {
    if (process.env['BLOB' + suffix]) return process.env['BLOB' + suffix];
    const key = Object.keys(process.env).find((n) => n.endsWith(suffix) && process.env[n]);
    return key ? process.env[key] : undefined;
  };
  const token = pick('_READ_WRITE_TOKEN');
  const storeId = pick('_STORE_ID');
  const o = {};
  if (token) o.token = token;
  else if (storeId) o.storeId = storeId;
  return o;
})();


// 구매현황 대시보드 서버 저장 API
// 화환 대시보드 / 공지사항과 같은 Vercel Blob 방식입니다.
//
// 브라우저 localStorage 에만 있던 5개 키를 한 덩어리로 서버에 보관합니다.
//   dashboard_db · dashboard_budget · dashboard_dept_budgets
//   dashboard_snapshots · dashboard_upload_info

const FILE_NAME = 'procurement-state.json';

const KEYS = [
  'dashboard_db',
  'dashboard_budget',
  'dashboard_dept_budgets',
  'dashboard_snapshots',
  'dashboard_upload_info'
];

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode();
  return result;
}

function emptyPayload() {
  return { keys: {}, savedAt: '', savedBy: '', saveVersion: '' };
}

async function readPayload() {
  try {
    const blob = await get(FILE_NAME, { access: 'private', ...BLOB_OPT });
    if (!blob || !blob.stream) return emptyPayload();

    const text = await streamToText(blob.stream);
    if (!text) return emptyPayload();

    const raw = JSON.parse(text);
    return {
      keys: (raw && typeof raw.keys === 'object' && raw.keys) || {},
      savedAt: String(raw?.savedAt || ''),
      savedBy: String(raw?.savedBy || ''),
      saveVersion: String(raw?.saveVersion || raw?.savedAt || '')
    };
  } catch (error) {
    const status = error?.status || error?.statusCode || error?.cause?.status;
    const message = String(error?.message || '').toLowerCase();

    if (status === 404 || message.includes('404') || message.includes('not found')) {
      return emptyPayload();
    }

    throw error;
  }
}

function nowKstText() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');

  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} `
       + `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())}`;
}

export default async function handler(req, res) {
  setHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const saved = await readPayload();

      return res.status(200).json({
        success: true,
        keys: saved.keys,
        savedAt: saved.savedAt,
        savedBy: saved.savedBy,
        saveVersion: saved.saveVersion
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const incoming = (body && typeof body.keys === 'object' && body.keys) || {};
      const savedBy = String(body.savedBy || '').trim() || '(이름없음)';

      // 알고 있는 키만 받습니다. 값은 문자열(localStorage 원본)로 저장합니다.
      const keys = {};
      for (const k of KEYS) {
        if (incoming[k] !== undefined && incoming[k] !== null) {
          keys[k] = String(incoming[k]);
        }
      }

      if (Object.keys(keys).length === 0) {
        return res.status(400).json({ success: false, message: '저장할 내용이 없습니다.' });
      }

      const savedAt = nowKstText();
      const saveVersion = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      await put(FILE_NAME, JSON.stringify({ keys, savedAt, savedBy, saveVersion }), {
        access: 'private',
        contentType: 'application/json',
        allowOverwrite: true,
        ...BLOB_OPT
      });

      return res.status(200).json({ success: true, savedAt, savedBy, saveVersion });
    }

    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  } catch (error) {
    console.error('[procurement state api error]', error);
    return res.status(500).json({ success: false, message: error.message || '서버 오류' });
  }
}
