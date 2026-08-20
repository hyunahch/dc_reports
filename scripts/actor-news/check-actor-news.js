// 배우 논란 뉴스 체크 스크립트 — GitHub Actions에서 1시간마다 실행됨
// 필요 env: SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
const webpush = require('web-push');

// .trim()으로 복사/붙여넣기 시 섞여 들어간 공백·개행을 방어적으로 제거
const SUPA_URL = (process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const VAPID_PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();

if (!SUPA_URL || !SERVICE_KEY || !VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('환경변수 누락:', {
    SUPABASE_URL: !!SUPA_URL,
    SUPABASE_SERVICE_KEY: !!SERVICE_KEY,
    VAPID_PUBLIC_KEY: !!VAPID_PUBLIC,
    VAPID_PRIVATE_KEY: !!VAPID_PRIVATE,
  });
  process.exit(1);
}

webpush.setVapidDetails('mailto:admin@dramacube.local', VAPID_PUBLIC, VAPID_PRIVATE);

// 논란 판별 키워드 (제목에 하나라도 포함되면 후보)
const KEYWORDS = ['논란','고소','피소','구설수','음주운전','마약','폭행','입건','기소','파문','물의','불륜','학폭','갑질','성추행','사기'];

// 넓게 잡는 검색어 (판권 유무 상관없이 배우/연예인 논란 전반)
const QUERIES = [
  '배우 (논란 OR 고소 OR 피소 OR 구설수 OR 음주운전 OR 마약 OR 폭행 OR 입건 OR 기소)',
  '연예인 (논란 OR 고소 OR 피소 OR 구설수 OR 음주운전 OR 마약 OR 폭행 OR 입건 OR 기소)'
];

function parseRssItems(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map(([, block]) => {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '').trim();
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    return { title, link, pubDate, source };
  });
}

async function supaFetch(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return res;
}

async function main() {
  const found = [];
  const seenUrls = new Set();

  for (const q of QUERIES) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetch(url);
    const xml = await res.text();
    const items = parseRssItems(xml).slice(0, 20); // 최신 20건만

    for (const item of items) {
      if (!item.link || seenUrls.has(item.link)) continue;
      const matched = KEYWORDS.find((kw) => item.title.includes(kw));
      if (!matched) continue;
      seenUrls.add(item.link);
      found.push({ ...item, matched });
    }
  }

  console.log(`검색된 후보 기사: ${found.length}건`);

  const newAlerts = [];
  for (const item of found) {
    const insertRes = await supaFetch('actor_news_alerts', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        actor_name: null,
        program_name: null,
        article_title: item.title,
        article_url: item.link,
        article_source: item.source || null,
        published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        matched_keyword: item.matched,
      }),
    });
    if (insertRes.status === 201) {
      const body = await insertRes.json();
      if (body.length > 0) newAlerts.push(item);
    }
  }

  console.log(`새로 발견된 알림: ${newAlerts.length}건`);

  if (newAlerts.length > 0) {
    const subsRes = await supaFetch('push_subscriptions?select=*');
    const subs = await subsRes.json();
    console.log(`구독자 수: ${subs.length}`);

    for (const alert of newAlerts) {
      const payload = JSON.stringify({
        title: `⚠ 배우 논란 감지: ${alert.matched}`,
        body: alert.title,
        url: alert.link,
      });
      for (const sub of subs) {
        const pushSub = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        try {
          await webpush.sendNotification(pushSub, payload);
        } catch (err) {
          console.error(`푸시 실패 (${sub.endpoint.slice(0, 50)}...): ${err.message}`);
          if (err.statusCode === 410 || err.statusCode === 404) {
            // 만료된 구독 삭제
            await supaFetch(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
              method: 'DELETE',
            });
          }
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
