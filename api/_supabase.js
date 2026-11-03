// GRFITI(Supabase) 계정 공통 — 검수사진앱(GRfiti)과 같은 계정·같은 방식입니다.
//
// 아이디 + "@grfiti.local" 을 이메일로 써서 Supabase 에 로그인하고,
// 부서는 계정의 user_metadata.dept_name 으로 정합니다.
//
// 키는 소스에 넣지 않습니다. Vercel 프로젝트 → Settings → Environment Variables
//   SUPABASE_ANON_KEY  (필수) — 검수사진앱 AppConfig 의 supabaseAnonKey 와 같은 값
//   SUPABASE_URL       (선택) — 비우면 GRFITI 주소를 씁니다
// ⚠️ service_role 키는 넣지 마세요. 이 화면은 로그인한 사람 권한(anon + 토큰)으로만 읽습니다.

export const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://kglirvxtrahqyjuecduj.supabase.co').replace(/\/+$/, '');
export const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
export const EMAIL_SUFFIX = '@grfiti.local';

// 이 부서 계정은 모든 부서를 골라 볼 수 있습니다.
export const ADMIN_DEPTS = ['전략구매팀'];

export function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

export async function sb(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: 'Bearer ' + (token || ANON_KEY),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}

export function bearerOf(req) {
  const h = String(req.headers?.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

/** 토큰으로 사용자 확인 → { ok, user, dept, name, isAdmin } */
export async function verify(req) {
  const token = bearerOf(req);
  if (!token || !ANON_KEY) return { ok: false, status: 401 };
  const { status, data } = await sb('/auth/v1/user', { token });
  if (status !== 200 || !data?.id) return { ok: false, status: 401 };
  const meta = data.user_metadata || {};
  const dept = String(meta.dept_name || '').trim();
  const name = String(meta.name || meta.full_name || meta.display_name || '').trim()
    || String(data.email || '').replace(EMAIL_SUFFIX, '');
  return { ok: true, token, user: data, dept, name, isAdmin: ADMIN_DEPTS.includes(dept) };
}

/** 부서명 비교 — 띄어쓰기·가운뎃점 표기 차이는 같은 부서로 봅니다. */
export const normDept = (s) => String(s || '').replace(/[\s·•ㆍ.\-_]/g, '').toLowerCase();
