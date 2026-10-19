// 카운팅 증강: 이번 핸드에 사용된 카드, 내가 모르는 남은 카드, 아웃츠와 리버까지 완성 확률.
// 보는 사람(카운팅 보유자)이 알 수 있는 카드만으로 계산한다 (실제 덱 순서는 쓰지 않음).

import { Card, fullDeck } from './cards.js';
import { bestHand, EvalRules } from './evaluator.js';
import type { UsedCard } from './types.js';

export interface CountingView {
  /** 이번 핸드에 사용된 카드 (번 카드, 폴드한 홀카드, 버려진 카드) */
  used: UsedCard[];
  /** 내가 모르는 카드 (상대 홀카드와 남은 덱이 섞여 있음) */
  unseen: Card[];
  /** 다음 카드 1장으로 지금보다 높은 족보 종류가 되는 카드 */
  outCards: Card[] | null;
  /** 리버까지 지금보다 높은 족보 종류가 될 확률 (0~1) */
  completion: number | null;
}

const cache = new Map<string, CountingView>();

export function countingInfo(myHole: Card[], board: Card[], used: UsedCard[], otherKnown: Card[], rules: EvalRules): CountingView {
  const key = JSON.stringify([myHole, board, used.map((u) => u.card), otherKnown, rules]);
  const hit = cache.get(key);
  if (hit) return hit;
  const known = new Set<Card>([...myHole, ...board, ...used.map((u) => u.card), ...otherKnown]);
  const unseen = fullDeck().filter((c) => !known.has(c));
  let outCards: Card[] | null = null;
  let completion: number | null = null;
  if (myHole.length && (board.length === 3 || board.length === 4)) {
    const cat = (cards: Card[]) => bestHand(cards, rules).category;
    const cur = cat([...myHole, ...board]);
    outCards = unseen.filter((c) => cat([...myHole, ...board, c]) > cur);
    if (board.length === 4) {
      completion = unseen.length ? outCards.length / unseen.length : 0;
    } else {
      // 턴·리버 두 장의 모든 조합
      let good = 0;
      let total = 0;
      for (let i = 0; i < unseen.length; i++) {
        for (let j = i + 1; j < unseen.length; j++) {
          total++;
          if (cat([...myHole, ...board, unseen[i], unseen[j]]) > cur) good++;
        }
      }
      completion = total ? good / total : 0;
    }
  }
  const view: CountingView = { used: used.map((u) => ({ ...u })), unseen, outCards, completion };
  cache.set(key, view);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return view;
}
