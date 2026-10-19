// 족보 판정기.
//
// 구조:
//  1) 5장 이하의 카드 묶음을 "자연 카드 + 와일드 n장"으로 나누어 해석적으로 최고 족보를 구한다(evaluateGroup).
//     와일드가 없고 변형 규칙도 없으면 표준 홀덤 판정과 동일하다.
//  2) 6~7장에서 5장을 고르는 모든 조합을 시도해 최댓값을 취한다(bestHand).
//  3) 플레이어별 변형 규칙(4장 플러시, 징검다리, 편애 와일드)은 EvalRules 로 넘긴다.
//     evaluatePlayerHand 는 표준 판정과 변형 판정을 모두 계산해, 변형이 실제로 족보를 올렸을 때만 "적용됨"으로 표시한다.
//
// 점수(score)는 [카테고리, 비교값...] 배열이며 사전식으로 비교한다.

import { Card, rankOf, suitOf, rankName, Suit } from './cards.js';

export const Category = {
  HighCard: 0,
  Pair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
  FiveKind: 9,
} as const;

export const CATEGORY_NAMES = [
  '하이카드',
  '원페어',
  '투페어',
  '트리플',
  '스트레이트',
  '플러시',
  '풀하우스',
  '포카드',
  '스트레이트 플러시',
  '파이브 카드',
];

export interface EvalRules {
  /** 같은 무늬 4장도 플러시 */
  fourFlush?: boolean;
  /** 숫자 하나가 빈 스트레이트 허용 */
  gapStraight?: boolean;
  /** A를 넘어 이어지는 스트레이트 허용 (Q-K-A-2-3, 끝 카드로 비교) */
  wrapStraight?: boolean;
  /** 이 숫자(2..14)의 카드는 와일드 */
  wildRank?: number | null;
}

export interface HandValue {
  score: number[];
  category: number;
  /** 족보에 쓰인 카드(최대 5장, 키커 포함) */
  cards: Card[];
  /** 그중 족보 자체를 이루는 핵심 카드 (페어의 두 장, 플러시의 같은 무늬 등. 키커 제외) */
  core: Card[];
  wildsUsed: number;
  usedFourFlush: boolean;
  usedGap: boolean;
  usedWrap: boolean;
  name: string;
}

export function compareScores(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

interface CoreResult {
  score: number[];
  usedFourFlush: boolean;
  usedGap: boolean;
  usedWrap: boolean;
}

interface StraightFit {
  top: number;
  normal: boolean;
  wrap: boolean;
}

/** 끝 숫자 end 에서 거꾸로 size 장의 연속 숫자 (2 아래는 A로 순환: 5-4-3-2-A, 3-2-A-K-Q) */
function cyclicWindow(end: number, size: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < size; k++) {
    let r = end - k;
    if (r < 2) r += 13;
    out.push(r);
  }
  return out;
}

/**
 * 서로 다른 자연 카드 숫자 집합을 와일드로 채워 만들 수 있는 가장 높은 스트레이트.
 * 숫자를 2→A→2 로 순환하는 고리로 보고, 끝 숫자(top)가 높은 창부터 찾는다.
 * K와 2를 함께 포함하는 창은 A를 넘어 이어지는 '원형'으로, 원형 스트레이트 보유자만 인정한다.
 * (A-2-3-4-5 휠과 10-J-Q-K-A 는 일반 스트레이트)
 */
function findStraight(ranks: number[], gapAllowed: boolean, wrapAllowed: boolean): StraightFit | null {
  for (let top = 14; top >= 2; top--) {
    for (const size of gapAllowed ? [5, 6] : [5]) {
      const win = cyclicWindow(top, size);
      const wrap = win.includes(13) && win.includes(2);
      if (wrap && !wrapAllowed) continue;
      if (!ranks.every((r) => win.includes(r))) continue;
      if (size === 5) return { top, normal: true, wrap };
      // 숫자 하나가 빈 스트레이트: 양 끝을 제외한 안쪽 숫자 중 하나가 비어 있어야 한다
      if (win.slice(1, 5).some((r) => !ranks.includes(r))) return { top, normal: false, wrap };
    }
  }
  return null;
}

/** 와일드가 플러시에 들어갈 때: 그 무늬에 아직 없는 가장 높은 숫자로 채운다 */
function fillFlushRanks(present: number[], wilds: number): number[] {
  const out = [...present];
  for (let r = 14; r >= 2 && wilds > 0; r--) {
    if (!out.includes(r)) {
      out.push(r);
      wilds--;
    }
  }
  return out.sort((a, b) => b - a);
}

/**
 * 자연 카드(naturals)와 와일드 w장으로 만들 수 있는 최고 족보.
 * 카드 수 합계는 5 이하. 스트레이트/플러시/풀하우스 계열은 5장일 때만 성립.
 */
function evaluateGroup(naturals: Card[], w: number, rules: EvalRules): CoreResult {
  const total = naturals.length + w;
  const ranks = naturals.map(rankOf);
  const cnt = new Map<number, number>();
  for (const r of ranks) cnt.set(r, (cnt.get(r) ?? 0) + 1);
  const distinct = [...cnt.keys()].sort((a, b) => b - a);
  const suitCnt = new Map<Suit, number>();
  for (const c of naturals) suitCnt.set(suitOf(c), (suitCnt.get(suitOf(c)) ?? 0) + 1);
  const allSameSuit = suitCnt.size <= 1;
  const ranksDistinct = distinct.length === naturals.length;
  const descRanks = [...ranks].sort((a, b) => b - a);

  const candidates: CoreResult[] = [];
  const push = (score: number[], usedFourFlush = false, usedGap = false, usedWrap = false) =>
    candidates.push({ score, usedFourFlush, usedGap, usedWrap });

  // 파이브 카드 (와일드가 있어야 가능)
  if (total === 5 && distinct.length <= 1 && w > 0) push([Category.FiveKind, distinct[0] ?? 14]);

  // 스트레이트 플러시 (5장이 모두 같은 무늬여야 함)
  if (total === 5 && allSameSuit && ranksDistinct) {
    const st = findStraight(distinct, !!rules.gapStraight, !!rules.wrapStraight);
    if (st) push([Category.StraightFlush, st.top, st.normal ? 1 : 0], false, !st.normal, st.wrap);
  }

  // 같은 숫자 묶음 계열: 가장 높은 숫자에 와일드를 몰아준다
  const kickersExcluding = (r: number, leftoverWilds: number, n: number) =>
    [...Array(leftoverWilds).fill(14), ...descRanks.filter((x) => x !== r)].slice(0, n);

  // 포카드
  if (total >= 4) {
    const q = distinct.find((r) => (cnt.get(r) ?? 0) + w >= 4);
    if (q !== undefined) {
      const left = w - Math.max(0, 4 - (cnt.get(q) ?? 0));
      push([Category.Quads, q, ...kickersExcluding(q, left, total - 4)]);
    } else if (w >= 4) {
      push([Category.Quads, 14, ...descRanks.slice(0, total - 4)]);
    }
  }

  // 풀하우스
  if (total === 5 && distinct.length === 2) {
    const [a, b] = distinct;
    const ca = cnt.get(a)!;
    const cb = cnt.get(b)!;
    if (ca <= 3 && cb <= 2) push([Category.FullHouse, a, b]);
    else if (cb <= 3 && ca <= 2) push([Category.FullHouse, b, a]);
  }

  // 플러시
  if (total === 5) {
    if (allSameSuit) {
      // 진짜 5장 플러시는 4장 플러시보다 항상 높다(두 번째 값 1)
      push([Category.Flush, 1, ...fillFlushRanks(ranks, w)]);
    } else if (rules.fourFlush) {
      for (const [s, n] of suitCnt) {
        if (n + w < 4) continue;
        const suited = naturals.filter((c) => suitOf(c) === s).map(rankOf);
        const used = Math.max(0, 4 - n);
        const flushRanks = fillFlushRanks(suited, used).slice(0, 4);
        const others = naturals.filter((c) => suitOf(c) !== s).map(rankOf);
        const kicker = w - used > 0 ? 14 : Math.max(...others);
        push([Category.Flush, 0, ...flushRanks, kicker], true);
      }
    }
  }

  // 스트레이트
  if (total === 5 && ranksDistinct) {
    const st = findStraight(distinct, !!rules.gapStraight, !!rules.wrapStraight);
    if (st) push([Category.Straight, st.top, st.normal ? 1 : 0], false, !st.normal, st.wrap);
  }

  // 트리플
  if (total >= 3) {
    const t = distinct.find((r) => (cnt.get(r) ?? 0) + w >= 3);
    if (t !== undefined) {
      const left = w - Math.max(0, 3 - (cnt.get(t) ?? 0));
      push([Category.Trips, t, ...kickersExcluding(t, left, total - 3)]);
    } else if (w >= 3) {
      push([Category.Trips, 14, ...descRanks.slice(0, total - 3)]);
    }
  }

  // 투페어 (와일드가 있으면 항상 트리플 이상이 가능하므로 자연 카드만)
  if (w === 0 && total >= 4) {
    const pairs = distinct.filter((r) => cnt.get(r)! >= 2);
    if (pairs.length >= 2) {
      const [p1, p2] = pairs;
      const kick = descRanks.filter((x) => x !== p1 && x !== p2).slice(0, total - 4);
      push([Category.TwoPair, p1, p2, ...kick]);
    }
  }

  // 원페어
  if (total >= 2) {
    const p = distinct.find((r) => (cnt.get(r) ?? 0) + w >= 2);
    if (p !== undefined) {
      const left = w - Math.max(0, 2 - (cnt.get(p) ?? 0));
      push([Category.Pair, p, ...kickersExcluding(p, left, total - 2)]);
    } else if (w >= 2) {
      push([Category.Pair, 14, ...descRanks.slice(0, total - 2)]);
    }
  }

  // 하이카드
  push([Category.HighCard, ...[...Array(w).fill(14), ...descRanks].slice(0, total)]);

  let best = candidates[0];
  for (const c of candidates) if (compareScores(c.score, best.score) > 0) best = c;
  return best;
}

function isWild(card: Card, rules: EvalRules): boolean {
  return rules.wildRank != null && rankOf(card) === rules.wildRank;
}

function evaluateFive(cards: Card[], rules: EvalRules): HandValue {
  const naturals = cards.filter((c) => !isWild(c, rules));
  const w = cards.length - naturals.length;
  const core = evaluateGroup(naturals, w, rules);
  return {
    score: core.score,
    category: core.score[0],
    cards: [...cards],
    core: coreCards(cards, rules, core),
    wildsUsed: w,
    usedFourFlush: core.usedFourFlush,
    usedGap: core.usedGap,
    usedWrap: core.usedWrap,
    name: describe(core),
  };
}

/** 족보를 이루는 핵심 카드: 같은 숫자 계열은 그 숫자 + 와일드, 5장 족보는 전부, 하이카드는 가장 높은 1장 */
function coreCards(cards: Card[], rules: EvalRules, core: CoreResult): Card[] {
  const s = core.score;
  const wild = (c: Card) => isWild(c, rules);
  switch (s[0]) {
    case Category.HighCard: {
      const top = [...cards].sort((a, b) => rankOf(b) - rankOf(a))[0];
      return top ? [top] : [];
    }
    case Category.Pair:
    case Category.Trips:
    case Category.Quads:
      return cards.filter((c) => wild(c) || rankOf(c) === s[1]);
    case Category.TwoPair:
      return cards.filter((c) => rankOf(c) === s[1] || rankOf(c) === s[2]);
    case Category.Flush:
      if (core.usedFourFlush) {
        // 4장 플러시: 가장 많은 무늬 + 와일드 (나머지 1장은 키커)
        const counts = new Map<Suit, number>();
        for (const c of cards) if (!wild(c)) counts.set(suitOf(c), (counts.get(suitOf(c)) ?? 0) + 1);
        const suit = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return cards.filter((c) => wild(c) || suitOf(c) === suit);
      }
      return [...cards];
    default:
      return [...cards];
  }
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const rec = (start: number) => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i]);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(0);
  return out;
}

/** 주어진 카드에서 5장을 골라 만들 수 있는 최고 족보 (5장 미만이면 있는 카드로만) */
export function bestHand(cards: Card[], rules: EvalRules = {}): HandValue {
  if (cards.length <= 5) return evaluateFive(cards, rules);
  let best: HandValue | null = null;
  for (const combo of combinations(cards, 5)) {
    const v = evaluateFive(combo, rules);
    if (!best || compareScores(v.score, best.score) > 0) best = v;
  }
  return best!;
}

export type AppliedVariant = 'fourFlush' | 'gapStraight' | 'wrapStraight' | 'wild';

/** 변형이 만든 족보 이름 (쇼다운 표시용) */
export const VARIANT_LABEL: Record<AppliedVariant, string> = {
  fourFlush: '4장 플러시',
  gapStraight: '징검다리 스트레이트',
  wrapStraight: '원형 스트레이트',
  wild: '와일드카드 사용',
};

export interface PlayerHandEval {
  value: HandValue;
  /** 표준 판정보다 족보를 끌어올린 변형 규칙 */
  applied: AppliedVariant[];
}

/** 플레이어 한 명의 최종 족보: 표준 판정 위에 그 플레이어의 변형 규칙을 얹는다 */
export function evaluatePlayerHand(hole: Card[], board: Card[], rules: EvalRules): PlayerHandEval {
  const cards = [...hole, ...board];
  const standard = bestHand(cards, {});
  const hasVariant = !!(rules.fourFlush || rules.gapStraight || rules.wrapStraight || rules.wildRank);
  if (!hasVariant) return { value: standard, applied: [] };
  const variant = bestHand(cards, rules);
  if (compareScores(variant.score, standard.score) <= 0) return { value: standard, applied: [] };
  const applied: AppliedVariant[] = [];
  if (variant.usedFourFlush) applied.push('fourFlush');
  if (variant.usedGap) applied.push('gapStraight');
  if (variant.usedWrap) applied.push('wrapStraight');
  if (variant.wildsUsed > 0) applied.push('wild');
  return { value: variant, applied };
}

function straightPrefix(core: CoreResult): string {
  return `${core.usedWrap ? '원형 ' : ''}${core.usedGap ? '징검다리 ' : ''}`;
}

/** 족보의 '숫자' 부분 (키커 제외): 절대 키커의 "같은 숫자의 같은 족보" 판정에 쓴다 */
const MAIN_LEN = [1, 1, 2, 1, 2, 2, 2, 1, 2, 1];
export function mainPart(score: readonly number[]): number[] {
  return score.slice(0, 1 + MAIN_LEN[score[0]]);
}

/**
 * 메이드 핸드: 최선 5장이 원페어 이상이고, 그 족보를 이루는 핵심 카드에 홀카드가 1장 이상 들어 있다.
 * (보드에만 있는 페어에 홀카드가 키커로 붙은 경우는 메이드가 아님)
 */
export function isMadeHand(hole: Card[], board: Card[], rules: EvalRules): boolean {
  if (!hole.length) return false;
  const v = evaluatePlayerHand(hole, board, rules).value;
  return v.category >= Category.Pair && v.core.some((c) => hole.includes(c));
}

function describe(core: CoreResult): string {
  const s = core.score;
  const cat = s[0];
  const n = (r: number) => rankName(r);
  switch (cat) {
    case Category.FiveKind:
      return `파이브 카드 (${n(s[1])})`;
    case Category.StraightFlush:
      if (s[1] === 14 && s[2] === 1) return '로열 플러시';
      return `${straightPrefix(core)}스트레이트 플러시 (${n(s[1])} 하이)`;
    case Category.Quads:
      return `포카드 (${n(s[1])})`;
    case Category.FullHouse:
      return `풀하우스 (${n(s[1])} / ${n(s[2])})`;
    case Category.Flush:
      return core.usedFourFlush ? `4장 플러시 (${n(s[2])} 하이)` : `플러시 (${n(s[2])} 하이)`;
    case Category.Straight:
      return `${straightPrefix(core)}스트레이트 (${n(s[1])} 하이)`;
    case Category.Trips:
      return `트리플 (${n(s[1])})`;
    case Category.TwoPair:
      return `투페어 (${n(s[1])}, ${n(s[2])})`;
    case Category.Pair:
      return `원페어 (${n(s[1])})`;
    default:
      return s.length > 1 ? `하이카드 (${n(s[1])})` : '하이카드';
  }
}
