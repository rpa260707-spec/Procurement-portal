// 설정 점검 — /api/envcheck
//
// 「SUPABASE_ANON_KEY 없음」이 계속 뜰 때, 원인이 셋 중 무엇인지 가려 줍니다.
//   1) 아직 안 넣음            → set:false
//   2) 넣었는데 Redeploy 안 함  → set:false  (환경변수는 새 배포에만 붙습니다)
//   3) 값이 service_role 이거나 만료  → set:true 인데 role 이 다름
//
// ⚠️ 키 값은 절대 내보내지 않습니다. 길이 · role · ref · 만료일만 봅니다.
//    이름을 통째로 훑지도 않습니다 — 아는 변수 세 개만 봅니다.

import { SUPABASE_URL, ANON_KEY, noStore } from './_supabase.js';

/* JWT 가운데 토막만 풀어 claim 을 봅니다. 서명은 확인하지 않습니다 —
   여기서 알고 싶은 것은 「어떤 종류의 키를 넣었나」 뿐입니다. */
function claims(jwt) {
  try {
    const p = String(jwt).split('.');
    if (p.length !== 3) return null;
    let b = p[1].replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - b.length % 4) % 4);        // JWT 는 패딩을 떼고 옵니다
    const j = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return {
      role: j.role || null,
      ref: j.ref || null,
      expires: j.exp ? new Date(j.exp * 1000).toISOString().slice(0, 10) : null,
      expired: j.exp ? (j.exp * 1000 < Date.now()) : null
    };
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  noStore(res);

  const set = !!ANON_KEY;
  const c = set ? claims(ANON_KEY) : null;

  const out = {
    checkedAt: new Date().toISOString(),
    SUPABASE_URL,                                  // 비밀이 아닙니다 (소스에 기본값으로 들어 있음)
    SUPABASE_URL_fromEnv: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: {
      set,
      length: set ? ANON_KEY.length : 0,
      role: c ? c.role : null,
      ref: c ? c.ref : null,
      expires: c ? c.expires : null,
      expired: c ? c.expired : null
    },
    live: null,
    verdict: '',
    next: ''
  };

  if (!set) {
    out.verdict = 'SUPABASE_ANON_KEY 가 이 배포에 없습니다.';
    out.next = '값을 넣었다면 Redeploy 가 빠진 것입니다. 환경변수는 넣은 뒤 새로 배포해야 붙습니다. '
             + '넣은 적이 없다면 Settings → Environment Variables 에서 Production 을 체크해 추가하세요.';
    return res.status(200).json(out);
  }

  if (c && c.role !== 'anon') {
    out.verdict = '넣은 키의 role 이 "' + c.role + '" 입니다 — anon 이어야 합니다.';
    out.next = 'service_role 키는 RLS 를 무시해 전 부서 자료가 열립니다. anon / public 키로 바꾸세요.';
    return res.status(200).json(out);
  }
  if (c && c.expired) {
    out.verdict = '키가 만료됐습니다 (' + c.expires + ').';
    out.next = 'Supabase 에서 새 anon 키를 받아 교체하세요.';
    return res.status(200).json(out);
  }

  /* 모양이 맞으면 실제로 먹히는지까지 봅니다. 로그인은 하지 않습니다 —
     아무나 부를 수 있는 공개 설정만 읽어 키가 살아 있는지만 확인합니다. */
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/settings', {
      headers: { apikey: ANON_KEY }
    });
    out.live = { status: r.status, ok: r.ok };
    out.verdict = r.ok
      ? '정상입니다. 로그인이 되어야 합니다.'
      : 'Supabase 가 이 키를 거부했습니다 (HTTP ' + r.status + ').';
    out.next = r.ok
      ? '/dept 에서 GRFITI 아이디로 로그인해 보세요.'
      : '키를 복사할 때 앞뒤 공백이나 줄바꿈이 섞이지 않았는지 확인하세요.';
  } catch (e) {
    out.live = { status: null, ok: false, error: String(e && e.message || e) };
    out.verdict = 'Supabase 에 닿지 못했습니다.';
    out.next = 'SUPABASE_URL 이 맞는지 확인하세요.';
  }

  return res.status(200).json(out);
}
