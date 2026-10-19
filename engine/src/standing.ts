// 쇼다운·순위표가 함께 쓰는 "지금 이 플레이어의 족보" 계산.
// 족보 변형(core.rulesFor) → 블랙잭(발동했을 때) → 순혈 조건 → 동점 처리 증강 순으로 Contender 를 만든다.

import type { Card } from './cards.js';
import { applyBlackjack, evaluatePlayerHand, type PlayerHandEval } from './evaluator.js';
import { evalBoard, findAug, invertedNow, live, rulesFor } from './core.js';
import { compareContenders, type Contender } from './showdown.js';
import type { GameState, PlayerState } from './types.js';

export function handEvalFor(state: GameState, p: PlayerState, board: Card[] = evalBoard(state)): PlayerHandEval {
  const ev = evaluatePlayerHand(p.hole, board, rulesFor(p));
  return p.blackjackOn ? applyBlackjack(ev, [...p.hole, ...board]) : ev;
}

export function contenderFor(state: GameState, p: PlayerState, ev: PlayerHandEval = handEvalFor(state, p)): Contender {
  const holeUsed = p.hole.filter((c) => ev.value.cards.includes(c)).length;
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
