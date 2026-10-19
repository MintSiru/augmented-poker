// 쇼다운·순위표가 함께 쓰는 "지금 이 플레이어의 족보" 계산.
// 족보 변형(core.rulesFor) → 블랙잭(발동했을 때) → 순혈 조건 → 동점 처리 증강 순으로 Contender 를 만든다.

import type { Card } from './cards.js';
import { rankOf } from './cards.js';
import { applyBlackjack, Category, CATEGORY_NAMES, compareScores, evaluatePlayerHand, type PlayerHandEval } from './evaluator.js';
import { evalBoard, findAug, invertedNow, live, rulesFor } from './core.js';
import { compareContenders, type Contender } from './showdown.js';
import type { GameState, PlayerState } from './types.js';

export function handEvalFor(state: GameState, p: PlayerState, board: Card[] = evalBoard(state)): PlayerHandEval {
  const hole = judgedHole(p);
  const one = (h: Card[]) => {
    const ev = evaluatePlayerHand(h, board, rulesFor(p));
    return p.blackjackOn ? applyBlackjack(ev, [...h, ...board]) : ev;
  };
  let ev = p.omaha ? omahaEval(p, hole, board) : one(hole);
  // 그림자 분신으로 바꾼 카드가 족보에 쓰였으면 표시
  if (p.shadow && ev.value.cards.includes(p.shadow.to) && !ev.applied.includes('shadow')) ev = { ...ev, applied: [...ev.applied, 'shadow'] };
  // 기생: 내 홀카드 1장 + 대상의 높은 홀카드 1장으로도 만들어 보고 더 좋은 쪽
  const host = p.parasite ? state.players.find((x) => x.id === p.parasite) : undefined;
  if (host && host.hole.length && !p.omaha) {
    const high = [...host.hole].sort((a, b) => rankOf(b) - rankOf(a))[0];
    const sign = invertedNow(state) ? -1 : 1;
    for (const c of hole) {
      const alt = one([c, high]);
      if (sign * compareScores(alt.value.score, ev.value.score) > 0) ev = alt;
    }
  }
  // 승격: 족보를 한 단계 위로 (최대 풀하우스)
  if (p.promoted && ev.value.category < Category.FullHouse) {
    const cat = ev.value.category + 1;
    ev = { ...ev, value: { ...ev.value, category: cat, score: [cat, ...ev.value.score.slice(1)], name: `${ev.value.name} → ${CATEGORY_NAMES[cat]} (승격)` } };
  }
  return ev;
}

/** 판정에 쓰는 홀카드: 연금술·그림자 분신으로 바꾼 카드 반영 */
export function judgedHole(p: PlayerState): Card[] {
  return p.hole.map((c, i) => (p.alchemy?.index === i ? p.alchemy.to : p.shadow?.index === i ? p.shadow.to : c));
}

/** 오마하의 피: 홀카드 2장을 모두 쓰는 최선의 족보를 한 단계 올린다 (최대 풀하우스) */
function omahaEval(p: PlayerState, hole: Card[], board: Card[]): PlayerHandEval {
  const two = hole.slice(0, 2);
  let best: PlayerHandEval | null = null;
  const rules = rulesFor(p);
  for (let a = 0; a < board.length; a++)
    for (let b = a + 1; b < board.length; b++)
      for (let c = b + 1; c < board.length; c++) {
        const ev = evaluatePlayerHand(two, [board[a], board[b], board[c]], rules);
        if (!best || compareScores(ev.value.score, best.value.score) > 0) best = ev;
      }
  // 보드가 3장 미만이면(있을 수 없지만) 있는 대로
  best ??= evaluatePlayerHand(two, board, rules);
  const cat = Math.min(Category.FullHouse, best.value.category + 1);
  if (best.value.category >= Category.FullHouse) return { ...best, applied: [...best.applied, 'omaha'] };
  return {
    value: { ...best.value, category: cat, score: [cat, ...best.value.score.slice(1)], name: `${best.value.name} → ${CATEGORY_NAMES[cat]} (오마하의 피)` },
    applied: [...best.applied, 'omaha'],
  };
}

export function contenderFor(state: GameState, p: PlayerState, ev: PlayerHandEval = handEvalFor(state, p)): Contender {
  const hole = judgedHole(p);
  const holeUsed = hole.filter((c) => ev.value.cards.includes(c)).length;
  return {
    id: p.id,
    score: ev.value.score,
    bestCards: ev.value.cards,
    kickerMaster: !!findAug(p, 'kickerMaster'),
    absoluteKicker: !!findAug(p, 'absoluteKicker'),
    pureBlood: !!findAug(p, 'pureBlood') && p.hole.length >= 2 && holeUsed >= 2,
  };
}

/** 순위표: 핸드에 남은 사람 중 지금 보드 기준 내 등수 (동점은 같은 등수) */
export function standingOf(state: GameState, me: PlayerState): { rank: number; of: number } {
  const board = evalBoard(state);
  const others = state.players.filter((p) => live(p) && p !== me);
  const mine = contenderFor(state, me, handEvalFor(state, me, board));
  const ctx = { inverted: invertedNow(state), board };
  const beaten = others.filter((o) => compareContenders(contenderFor(state, o, handEvalFor(state, o, board)), mine, ctx).result > 0).length;
  return { rank: beaten + 1, of: others.length + 1 };
}
