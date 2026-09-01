#!/usr/bin/env python3
import datetime as dt
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FEED_PATH = ROOT / 'bjjnote-content' / 'beginner-competition-videos.json'
TARGET_ROTATING = 3
HISTORY_LIMIT = 48
QUERIES = [
    'BJJ white belt first competition match',
    'jiu jitsu white belt tournament match',
    'first BJJ tournament white belt',
]

POSITIVE = re.compile(r'\b(white\s*belt|first|competition|tournament|match|matches|comp)\b', re.I)
BJJ = re.compile(r'\b(bjj|jiu[ -]?jitsu|jiujitsu)\b', re.I)
NEGATIVE = re.compile(r'\b(tutorial|instructional|how to|tips|reaction|shorts?|kids?|juvenile|black belt|brown belt|purple belt)\b', re.I)


def load_feed():
    with FEED_PATH.open('r', encoding='utf-8') as f:
        return json.load(f)


def search(query):
    cmd = [
        'yt-dlp', '--ignore-errors', '--no-warnings', '--skip-download', '--dump-json',
        f'ytsearchdate12:{query}'
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=240, check=False)
    except Exception as exc:
        print(f'[refresh] search failed for {query!r}: {exc}')
        return []
    results = []
    for line in proc.stdout.splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        if isinstance(item, dict):
            results.append(item)
    if proc.returncode != 0:
        print(f'[refresh] yt-dlp returned {proc.returncode} for {query!r}; keeping successful rows')
    return results


def score(item):
    title = str(item.get('title') or '')
    lower = title.lower()
    duration = int(item.get('duration') or 0)
    if not BJJ.search(title) and 'white belt' not in lower:
        return None
    if not POSITIVE.search(title):
        return None
    if NEGATIVE.search(title) and 'white belt' not in lower:
        return None
    if duration and not (90 <= duration <= 2400):
        return None
    if item.get('playable_in_embed') is False:
        return None
    video_id = str(item.get('id') or '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{6,20}', video_id):
        return None

    points = 0.0
    if 'white belt' in lower or 'whitebelt' in lower:
        points += 8
    if 'first' in lower:
        points += 5
    if re.search(r'competition|tournament|match|matches|comp', lower):
        points += 5
    if BJJ.search(title):
        points += 2
    if 120 <= duration <= 1200:
        points += 2
    views = int(item.get('view_count') or 0)
    if views > 0:
        points += min(3, math.log10(max(10, views)) - 2)
    upload_date = str(item.get('upload_date') or '')
    try:
        published = dt.datetime.strptime(upload_date, '%Y%m%d').date()
        age = (dt.datetime.now(dt.timezone.utc).date() - published).days
        if age <= 90:
            points += 4
        elif age <= 365:
            points += 2
    except Exception:
        pass
    return points


def make_video(item, now):
    title = str(item.get('title') or '').strip()
    channel = str(item.get('channel') or item.get('uploader') or 'YouTube').strip()
    duration = int(item.get('duration') or 0)
    if duration:
        mins, secs = divmod(duration, 60)
        duration_label = f'{mins}:{secs:02d}'
    else:
        duration_label = '경기 영상'
    video_id = str(item['id'])
    return {
        'id': f'weekly-{video_id}',
        'youtubeId': video_id,
        'title': f'이번 주 발견 · {title[:72]}',
        'originalTitle': title,
        'channel': channel,
        'duration': duration_label,
        'categories': ['first', 'opening', 'operation'],
        'badge': '이번 주 새 영상 · 초보 경기',
        'summary': '최근 검색에서 새로 찾은 화이트벨트·첫 대회 후보입니다. 정답 동작을 따라 하기보다 경기 속도와 첫 판단을 비교해서 봅니다.',
        'watchPoints': [
            '시작 신호 직후 두 선수의 첫발과 거리 변화',
            '처음 계획이 막혔을 때 멈추는지 다음 포지션으로 전환하는지',
            '좋은 위치를 얻은 뒤 공격보다 베이스와 압박을 먼저 만드는지',
        ],
        'startSeconds': 0,
        'sourceType': 'weekly-auto',
        'discoveredAt': now,
    }


def main():
    feed = load_feed()
    core = [v for v in feed.get('videos', []) if v.get('sourceType') == 'curated-core']
    previous_rotating = [v for v in feed.get('videos', []) if v.get('sourceType') == 'weekly-auto']
    history = [str(v) for v in feed.get('rotationHistory', []) if v]
    blocked = {str(v.get('youtubeId')) for v in core}
    blocked.update(history)

    candidates = {}
    for query in QUERIES:
        for item in search(query):
            video_id = str(item.get('id') or '')
            item_score = score(item)
            if item_score is None or video_id in blocked:
                continue
            current = candidates.get(video_id)
            if current is None or item_score > current[0]:
                candidates[video_id] = (item_score, item)

    ranked = [item for _, item in sorted(candidates.values(), key=lambda pair: pair[0], reverse=True)]
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    selected = [make_video(item, now) for item in ranked[:TARGET_ROTATING]]

    if not selected:
        print('[refresh] no new safe candidates; preserving current feed')
        return

    if len(selected) < TARGET_ROTATING:
        selected_ids = {v['youtubeId'] for v in selected}
        for old in previous_rotating:
            if old.get('youtubeId') not in selected_ids:
                selected.append(old)
            if len(selected) >= TARGET_ROTATING:
                break

    new_ids = [v['youtubeId'] for v in selected if v.get('youtubeId')]
    feed['updatedAt'] = now
    feed['curationMode'] = 'hybrid-curated-weekly'
    feed['videos'] = core + selected[:TARGET_ROTATING]
    feed['rotationHistory'] = (history + new_ids)[-HISTORY_LIMIT:]
    FEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    with FEED_PATH.open('w', encoding='utf-8') as f:
        json.dump(feed, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'[refresh] published {len(selected[:TARGET_ROTATING])} rotating videos; total={len(feed["videos"])}')


if __name__ == '__main__':
    main()
