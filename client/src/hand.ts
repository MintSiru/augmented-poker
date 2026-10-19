// "내 족보" 표시: 족보 배지, 강도 막대, 카드 강조, 족보표.
// 모두 서버가 보내 준 내 뷰(view.you.hand)만으로 그린다.

import type { PlayerView } from '../../engine/src/view.js';
import { cardHtml, esc } from './dom.js';

/** 족보 서열 (낮음 → 높음). 9 파이브 카드는 편애(와일드) 보유자에게만 표시 */
const LADDER = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시', '파이브 카드'];

const EXAMPLES: Record<number, string[]> = {
  9: ['As', 'Ah', 'Ad', 'Ac', 'W'],
  8: ['9h', '8h', '7h', '6h', '5h'],
  7: ['Ks', 'Kh', 'Kd', 'Kc'],
  6: ['Qs', 'Qh', 'Qd', '7c', '7d'],
  5: ['Ac', 'Jc', '9c', '6c', '3c'],
  4: ['9s', '8d', '7h', '6c', '5s'],
  3: ['7s', '7h', '7d'],
  2: ['Ks', 'Kd', '7h', '7c'],
  1: ['As', 'Ah'],
  0: ['As'],
};

function hasAug(v: PlayerView, id: string) {
  return v.you.augments.some((a) => a.id === id);
}

function wildChar(v: PlayerView): string | null {
  const w = v.you.augments.find((a) => a.id === 'favoritism')?.wildRank;
  if (!w) return null;
  return w === '10' ? 'T' : w;
}

/** 카드 강조 클래스: 족보 핵심(hl-core) / 키커(hl-kick) / 안 쓰임(hl-off) + 와일드 표시 */
export function handCardClass(v: PlayerView, card: string): string {
  const h = v.you.hand;
  const cls: string[] = [];
  if (h) {
    if (h.core.includes(card)) cls.push('hl-core');
    else if (h.cards.includes(card)) cls.push('hl-kick');
    else cls.push('hl-off');
  }
  const w = wildChar(v);
  if (w && card[0] === w) cls.push('wild');
  return cls.join(' ');
}

/** 손패 옆 "내 족보" 패널 */
export function handPanelHtml(v: PlayerView): string {
  const h = v.you.hand;
  if (!h) return v.table.inverted && v.you.holeHidden ? '<div class="myhand inverted"><div class="mh-name">족보 역전 중</div></div>' : '';
  const maxCat = hasAug(v, 'favoritism') ? 9 : 8;
  const steps = Array.from({ length: maxCat + 1 }, (_, i) => {
    const cls = i < h.category ? 'on' : i === h.category ? 'on cur' : '';
    return `<i class="${cls}" title="${LADDER[i]}"></i>`;
  }).join('');
  const chips = [
    ...h.applied.map((a) => `<span class="mh-chip aug">✨ ${esc(a)} 적용</span>`),
    ...(h.wild.length ? [`<span class="mh-chip wildc">와일드 ${h.wild.length}장 사용</span>`] : []),
    ...h.tags.map((t) => `<span class="mh-chip">${esc(t)}</span>`),
  ].join('');
  const inv = h.inverted ? '<div class="mh-inv">↕ 족보 역전 중: 낮은 패가 이깁니다</div>' : '';
  return `<div class="myhand cat${h.category}${h.inverted ? ' inverted' : ''}">
      <div class="mh-top">
        <span class="mh-label">${h.preflop ? '지금 손패' : '내 족보'}</span>
        <button class="mh-help small" data-a="handTable" title="족보표 보기">족보표</button>
      </div>
      <div class="mh-name">${esc(h.name)}</div>
      <div class="ladder" title="족보 강도: ${LADDER[h.category]} (${h.category + 1}/${maxCat + 1}단계)">${steps}</div>
      ${chips ? `<div class="mh-chips">${chips}</div>` : ''}
      ${inv}
    </div>`;
}

/** 족보표 (내 족보 위치와 내 증강의 변형 규칙 표시) */
export function handTableHtml(v: PlayerView): string {
  const h = v.you.hand;
  const maxCat = hasAug(v, 'favoritism') ? 9 : 8;
  const w = v.you.augments.find((a) => a.id === 'favoritism')?.wildRank;
  const notes: Record<number, string> = {};
  if (hasAug(v, 'fourFlush')) notes[5] = '4장 플러시: 같은 무늬 4장도 인정';
  if (hasAug(v, 'gapStraight')) notes[4] = '징검다리: 숫자 하나 빈 것도 인정 (5-6-8-9-10)';
  if (hasAug(v, 'wrapStraight')) notes[4] = [notes[4], '원형: A를 넘어 이어짐 (Q-K-A-2-3, 끝 카드로 비교)'].filter(Boolean).join(' / ');
  if (hasAug(v, 'kickerMaster')) notes[0] = '키커 장인: 완전 동점이면 내가 이김';
  if (hasAug(v, 'absoluteKicker')) notes[1] = '절대 키커: 같은 숫자의 같은 족보면 키커와 상관없이 내가 이김';
  if (w) notes[9] = `편애: ${w} 카드가 와일드`;
  const rows = [];
  for (let i = maxCat; i >= 0; i--) {
    const ex = EXAMPLES[i]
      .map((c) => (c === 'W' ? '<span class="card sm inline wildex">W</span>' : cardHtml(c, { size: 'sm', extra: 'inline' })))
      .join('');
    const mine = h && h.category === i;
    rows.push(`<div class="ht-row ${mine ? 'mine' : ''}">
      <span class="ht-rank">${i + 1}</span>
      <span class="ht-name">${LADDER[i]}${mine ? ' <b>← 지금</b>' : ''}</span>
      <span class="ht-ex">${ex}</span>
      ${notes[i] ? `<span class="ht-note">✨ ${esc(notes[i])}</span>` : ''}
    </div>`);
  }
  return `<div class="handtable">
      <div class="ht-head"><b>족보표</b> <span class="muted">${v.table.inverted ? '족보 역전 중: 아래로 갈수록 강함' : '위로 갈수록 강함'}</span><button class="small" data-a="handTable">닫기</button></div>
      ${rows.join('')}
      ${h ? `<div class="ht-mine">내 족보: <b>${esc(h.name)}</b></div>` : ''}
    </div>`;
}
