// 쇼다운 승자 판정: 족보 역전(밥상 뒤집기)과 동점 처리 증강(키커 장인, 절대 키커)
//
// 규칙
// - 각자의 족보는 먼저 족보 변형 증강을 적용해 "그 사람에게 가장 높은 족보"로 계산한다.
// - 역전이 홀수 번이면 비교 결과를 뒤집는다 (키커 비교까지 모두). 짝수 번이면 상쇄.
// - 키커 장인: 족보·키커까지 완전히 같으면 보유자가 이긴다.
// - 절대 키커: 같은 숫자의 같은 족보면 키커와 상관없이 보유자가 이긴다. 단, 둘 다 보드 5장만으로 만든 완전 동점은 스플릿.
// - 동점 처리 증강은 역전 중에도 "보유자가 이긴다"로 동작한다. 양쪽 모두 동점 처리 증강(종류 무관)을 가졌으면 서로 상쇄되어 원래 비교.
// - 순혈: 최종 족보에 홀카드 2장이 모두 쓰였으면 같은 족보 종류끼리는 숫자와 상관없이 보유자가 이긴다 (역전 중에도 보유자 승리, 둘 다 조건을 만족하면 원래 비교).

import type { Card } from './cards.js';
import type { AugmentId } from './augments.js';
import { compareScores, mainPart } from './evaluator.js';

export interface Contender {
  id: string;
  score: number[];
  bestCards: Card[];
  kickerMaster: boolean;
  absoluteKicker: boolean;
  /** 순혈 보유 + 홀카드 2장이 모두 최종 족보에 쓰였는가 */
  pureBlood?: boolean;
}

export interface CompareContext {
  inverted: boolean;
  /** 족보 계산에 쓰인 보드 (보드만으로 만든 동점 판정) */
  board: Card[];
}

interface Outcome {
  /** 양수면 a 승 */
  result: number;
  /** a 가 이겼다면 그 승리를 만든 동점 처리 증강 */
  by: AugmentId | null;
}

function boardOnly(c: Contender, board: Card[]): boolean {
  return c.bestCards.length === 5 && c.bestCards.every((x) => board.includes(x));
}

/** 이 비교에서 동점 처리 증강을 내세울 수 있는가 */
function hasTiebreak(c: Contender): boolean {
  return c.kickerMaster || c.absoluteKicker || !!c.pureBlood;
}

export function compareContenders(a: Contender, b: Contender, ctx: CompareContext): Outcome {
  // 서로 다른 사람의 동점 처리 증강이 같은 비교에서 맞붙으면 상쇄되어 원래 비교로
  if (hasTiebreak(a) && hasTiebreak(b)) {
    const raw = compareScores(a.score, b.score);
    return { result: ctx.inverted ? -raw : raw, by: null };
  }
  if (a.score[0] === b.score[0] && !!a.pureBlood !== !!b.pureBlood) {
    // 순혈이 실제로 승부를 뒤집었을 때만 "순혈 적용"으로 표시
    const plain = compareScores(a.score, b.score) * (ctx.inverted ? -1 : 1);
    return a.pureBlood ? { result: 1, by: plain > 0 ? null : 'pureBlood' } : { result: -1, by: null };
  }
  const raw = compareScores(a.score, b.score);
  const base = ctx.inverted ? -raw : raw;
  if (raw === 0) {
    const bothBoard = boardOnly(a, ctx.board) && boardOnly(b, ctx.board);
    const aClaim: AugmentId | null = a.kickerMaster ? 'kickerMaster' : a.absoluteKicker && !bothBoard ? 'absoluteKicker' : null;
    const bClaim: AugmentId | null = b.kickerMaster ? 'kickerMaster' : b.absoluteKicker && !bothBoard ? 'absoluteKicker' : null;
    if (aClaim && !bClaim) return { result: 1, by: aClaim };
    if (bClaim && !aClaim) return { result: -1, by: null };
    return { result: 0, by: null };
  }
  if (compareScores(mainPart(a.score), mainPart(b.score)) === 0) {
    if (a.absoluteKicker && !b.absoluteKicker) return { result: 1, by: base > 0 ? null : 'absoluteKicker' };
    if (b.absoluteKicker && !a.absoluteKicker) return { result: -1, by: null };
  }
  return { result: base, by: null };
}

export interface PotDecision {
  winners: string[];
  /** 승자별로 승부를 가른 동점 처리 증강 */
  decidedBy: Record<string, AugmentId[]>;
}

/**
 * 한 팟의 승자: 다른 누구에게도 지지 않는 사람들.
 * (동점 처리 증강 때문에 비교가 순환하면 순수 족보 순위로 정한다)
 */
export function decidePot(contenders: Contender[], ctx: CompareContext): PotDecision {
  const decidedBy: Record<string, AugmentId[]> = {};
  let winners = contenders.filter((x) => !contenders.some((y) => y !== x && compareContenders(y, x, ctx).result > 0));
  if (!winners.length) {
    const sign = ctx.inverted ? -1 : 1;
    let best = contenders[0];
    for (const c of contenders) if (sign * compareScores(c.score, best.score) > 0) best = c;
    winners = contenders.filter((c) => compareScores(c.score, best.score) === 0);
  }
  for (const w of winners) {
    const tags = new Set<AugmentId>();
    for (const l of contenders) {
      if (l === w) continue;
      const o = compareContenders(w, l, ctx);
      if (o.result > 0 && o.by) tags.add(o.by);
    }
    if (tags.size) decidedBy[w.id] = [...tags];
  }
  return { winners: winners.map((w) => w.id), decidedBy };
}
