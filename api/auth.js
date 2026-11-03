import { sb, noStore, bearerOf, ANON_KEY, EMAIL_SUFFIX, ADMIN_DEPTS } from './_supabase.js';

// 로그인 · 세션 연장 · 로그아웃
//
// POST /api/auth  { action:'login',   username, password }
// POST /api/auth  { action:'refresh', refresh_token }
// POST /api/auth  { action:'logout' }   (Authorization: Bearer <access_token>)
//
// 비밀번호는 이 함수가 Supabase 로 그대로 넘기기만 하고 어디에도 남기지 않습니다.

function sessionOut(data) {
  const meta = data?.user?.user_metadata || {};
  const dept = String(meta.dept_name || '').trim();
  return {
    success: true,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    dept,
    name: String(meta.name || meta.full_name || meta.display_name || '').trim()
      || String(data?.user?.email || '').replace(EMAIL_SUFFIX, ''),
    isAdmin: ADMIN_DEPTS.includes(dept)
  };
}

export default async function handler(req, res) {
  noStore(res);
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: '허용되지 않은 메서드입니다.' });
  }
  if (!ANON_KEY) {
    return res.status(500).json({ success: false,
      message: '서버 설정이 끝나지 않았습니다 (SUPABASE_ANON_KEY 없음). 전략구매팀에 문의하세요.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = String(body.action || '');

  try {
    if (action === 'login') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해 주세요.' });
      }
      const email = username.includes('@') ? username : username + EMAIL_SUFFIX;
      const { status, data } = await sb('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email, password }
      });
      if (status === 200 && data?.access_token) {
        const out = sessionOut(data);
        if (!out.dept) {
          return res.status(403).json({ success: false,
            message: '계정에 부서가 지정되어 있지 않습니다. 전략구매팀에 문의하세요.' });
        }
        return res.status(200).json(out);
      }
      const code = String(data?.error_code || data?.error || '');
      if (code === 'invalid_credentials' || code === 'invalid_grant' || status === 400) {
        return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다' });
      }
      return res.status(502).json({ success: false, message: `로그인 실패 (${status})` });
    }

    if (action === 'refresh') {
      const refresh = String(body.refresh_token || '');
      if (!refresh) return res.status(401).json({ success: false, message: '다시 로그인해 주세요.' });
      const { status, data } = await sb('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: { refresh_token: refresh }
      });
      if (status === 200 && data?.access_token) return res.status(200).json(sessionOut(data));
      return res.status(401).json({ success: false, message: '로그인이 만료되었습니다. 다시 로그인해 주세요.' });
    }

    if (action === 'logout') {
      const token = bearerOf(req);
      if (token) await sb('/auth/v1/logout', { method: 'POST', token });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, message: '알 수 없는 요청입니다.' });
  } catch (e) {
    console.error('[auth api error]', e);
    return res.status(502).json({ success: false, message: '로그인 서버에 연결하지 못했습니다.' });
  }
}
