import { describe, expect, it } from 'vitest';
import { bestHand, compareScores, evaluatePlayerHand, Category } from '../src/evaluator.js';

const h = (s: string) => s.split(/\s+/).filter(Boolean);
const best = (cards: string, rules = {}) => bestHand(h(cards), rules);

describe('표준 족보', () => {
  it.each([
    ['As Ks Qs Js Ts 2c 3d', [Category.StraightFlush, 14, 1], '로열 플러시'],
    ['9h 8h 7h 6h 5h Ac Ad', [Category.StraightFlush, 9, 1], '스트레이트 플러시 (9 하이)'],
    ['Ah 2h 3h 4h 5h Kc Kd', [Category.StraightFlush, 5, 1], '스트레이트 플러시 (5 하이)'],
    ['Ac Ad Ah As Kc 2d 3d', [Category.Quads, 14, 13], '포카드 (A)'],
    ['Kc Kd Kh 2s 2c 9d 8h', [Category.FullHouse, 13, 2], '풀하우스 (K / 2)'],
    ['Kc Kd Kh 2s 2c 2d 9h', [Category.FullHouse, 13, 2], '풀하우스 (K / 2)'],
    ['Ac Jc 9c 6c 3c Kd Qh', [Category.Flush, 1, 14, 11, 9, 6, 3], '플러시 (A 하이)'],
    ['Ac Jc 9c 6c 3c 2c Qh', [Category.Flush, 1, 14, 11, 9, 6, 3], '플러시 (A 하이)'],
    ['9c 8d 7h 6s 5c Kd 2h', [Category.Straight, 9, 1], '스트레이트 (9 하이)'],
    ['Ac 2d 3h 4s 5c Kd Qh', [Category.Straight, 5, 1], '스트레이트 (5 하이)'],
    ['Ac Kd Qh Js Tc 2d 3h', [Category.Straight, 14, 1], '스트레이트 (A 하이)'],
    ['7c 7d 7h Ks 2c 9d 4h', [Category.Trips, 7, 13, 9], '트리플 (7)'],
    ['Kc Kd 7h 7s 2c 9d 4h', [Category.TwoPair, 13, 7, 9], '투페어 (K, 7)'],
    ['Kc Kd 7h 7s 2c 2d 4h', [Category.TwoPair, 13, 7, 4], '투페어 (K, 7)'],
    ['Ac Ad 9h 7s 4c 3d 2h', [Category.Pair, 14, 9, 7, 4], '원페어 (A)'],
    ['Ac Jd 9h 7s 4c 3d 2h', [Category.HighCard, 14, 11, 9, 7, 4], '하이카드 (A)'],
  ])('%s → %s', (cards, score, name) => {
    const v = best(cards);
    expect(v.score).toEqual(score);
    expect(v.name).toBe(name);
    expect(v.cards).toHaveLength(5);
  });

  it('스트레이트는 A를 넘어 이어지지 않는다 (Q-K-A-2-3)', () => {
    expect(best('Qc Kd Ah 2s 3c 8d 9h').category).toBe(Category.HighCard);
  });

  it('6장 연속이면 가장 높은 스트레이트', () => {
    expect(best('4c 5d 6h 7s 8c 9d Kh').score).toEqual([Category.Straight, 9, 1]);
  });

  it('족보 서열', () => {
    const order = [
      'Ac Jd 9h 7s 4c 3d 2h', // 하이카드
      'Ac Ad 9h 7s 4c 3d 2h', // 원페어
      'Kc Kd 7h 7s 2c 9d 4h', // 투페어
      '7c 7d 7h Ks 2c 9d 4h', // 트리플
      '9c 8d 7h 6s 5c Kd 2h', // 스트레이트
      'Ac Jc 9c 6c 3c Kd Qh', // 플러시
      'Kc Kd Kh 2s 2c 9d 8h', // 풀하우스
      'Ac Ad Ah As Kc 2d 3d', // 포카드
      '9h 8h 7h 6h 5h Ac Ad', // 스트레이트 플러시
    ].map((c) => best(c).score);
    for (let i = 1; i < order.length; i++) expect(compareScores(order[i], order[i - 1])).toBeGreaterThan(0);
  });

  it('키커 비교와 무승부', () => {
    const a = best('Ac Ad Kh 7s 4c 3d 2h');
    const b = best('Ah As Qh 7d 4s 3c 2d');
    expect(compareScores(a.score, b.score)).toBeGreaterThan(0);
    // 보드가 가장 좋으면 무승부
    const board = 'As Ks Qs Js Ts';
    expect(compareScores(best(`2c 3d ${board}`).score, best(`4h 5h ${board}`).score)).toBe(0);
    // 투페어 키커
    expect(compareScores(best('Kc Kd 7h 7s Ac 2d 3h').score, best('Kh Ks 7c 7d Qc 2h 3d').score)).toBeGreaterThan(0);
    // 플러시는 다섯 장 모두 비교
    expect(compareScores(best('Ac Jc 9c 6c 3c').score, best('Ad Jd 9d 6d 2d').score)).toBeGreaterThan(0);
    // 휠은 가장 낮은 스트레이트
    expect(compareScores(best('2c 3d 4h 5s 6c').score, best('Ac 2d 3h 4s 5c').score)).toBeGreaterThan(0);
  });
});

describe('4장 플러시 (보유자에게만)', () => {
  const rules = { fourFlush: true };
  it('같은 무늬 4장을 플러시로 인정', () => {
    const r = evaluatePlayerHand(h('Ah 9h'), h('Kh 2h Qs Jc 5d'), rules);
    expect(r.value.category).toBe(Category.Flush);
    expect(r.value.score).toEqual([Category.Flush, 0, 14, 13, 9, 2, 12]);
    expect(r.applied).toEqual(['fourFlush']);
    expect(r.value.name).toContain('4장 플러시');
  });
  it('보유하지 않은 사람에게는 적용되지 않음', () => {
    expect(evaluatePlayerHand(h('Ah 9h'), h('Kh 2h Qs Jc 5d'), {}).value.category).toBe(Category.HighCard);
  });
  it('진짜 5장 플러시가 4장 플러시보다 높다', () => {
    const four = evaluatePlayerHand(h('Ah Kh'), h('Qh Jh 2c 3d 9s'), rules).value.score;
    const five = evaluatePlayerHand(h('2h 4h'), h('Qh Jh 7h 3d 9s'), {}).value.score;
    expect(compareScores(five, four)).toBeGreaterThan(0);
  });
  it('4장 플러시는 스트레이트보다 높고 풀하우스보다 낮다', () => {
    const four = evaluatePlayerHand(h('Ah Kh'), h('Qh 2h 7c 3d 9s'), rules).value.score;
    expect(compareScores(four, best('9c 8d 7h 6s 5c').score)).toBeGreaterThan(0);
    expect(compareScores(four, best('Kc Kd Kh 2s 2c').score)).toBeLessThan(0);
  });
  it('더 좋은 족보가 있으면 변형이 적용되지 않은 것으로 표시', () => {
    const r = evaluatePlayerHand(h('Ah Ad'), h('As Kh 2h 3h Ac'), rules);
    expect(r.value.category).toBe(Category.Quads);
    expect(r.applied).toEqual([]);
  });
});

describe('징검다리 (보유자에게만)', () => {
  const rules = { gapStraight: true };
  it('5-6-8-9-10 은 스트레이트', () => {
    const r = evaluatePlayerHand(h('5c 6d'), h('8h 9s Tc 2d 2h'), rules);
    expect(r.value.score).toEqual([Category.Straight, 10, 0]);
    expect(r.applied).toEqual(['gapStraight']);
    expect(r.value.name).toBe('징검다리 스트레이트 (10 하이)');
  });
  it('A-2-3-4-6 과 9-10-Q-K-A', () => {
    expect(best('Ac 2d 3h 4s 6c', rules).score).toEqual([Category.Straight, 6, 0]);
    expect(best('9c Td Qh Ks Ac', rules).score).toEqual([Category.Straight, 14, 0]);
  });
  it('구멍이 두 개면 스트레이트가 아님', () => {
    expect(best('5c 6d 8h Ts Jc', rules).category).toBe(Category.HighCard);
  });
  it('일반 스트레이트는 같은 하이카드의 징검다리보다 높다', () => {
    expect(compareScores(best('6c 7d 8h 9s Tc').score, best('5c 6d 8h 9s Tc', rules).score)).toBeGreaterThan(0);
  });
  it('끊김 없는 5장은 한 칸 위 징검다리로 올라가지 않는다', () => {
    expect(best('5c 6d 7h 8s 9c', rules).score).toEqual([Category.Straight, 9, 1]);
  });
  it('같은 무늬면 징검다리 스트레이트 플러시', () => {
    expect(best('5h 6h 8h 9h Th', rules).score).toEqual([Category.StraightFlush, 10, 0]);
  });
  it('보유하지 않은 사람에게는 적용되지 않음', () => {
    expect(evaluatePlayerHand(h('5c 6d'), h('8h 9s Tc 2d 2h'), {}).value.category).toBe(Category.Pair);
  });
});

describe('편애 (와일드카드)', () => {
  it('와일드 2장 + A 페어 → A 포카드', () => {
    const r = evaluatePlayerHand(h('7c 7d'), h('As Ad Kc 2h 9s'), { wildRank: 7 });
    expect(r.value.score).toEqual([Category.Quads, 14, 13]);
    expect(r.applied).toEqual(['wild']);
  });
  it('파이브 카드', () => {
    expect(best('7c 7d As Ad Ah', { wildRank: 7 }).score).toEqual([Category.FiveKind, 14]);
  });
  it('파이브 카드는 스트레이트 플러시보다 높다', () => {
    expect(compareScores(best('7c 7d As Ad Ah', { wildRank: 7 }).score, best('As Ks Qs Js Ts').score)).toBeGreaterThan(0);
  });
  it('빈 숫자를 채워 스트레이트', () => {
    const r = evaluatePlayerHand(h('7c 2d'), h('8h 9d Ts Qc 3h'), { wildRank: 7 });
    expect(r.value.score).toEqual([Category.Straight, 12, 1]);
    expect(r.applied).toEqual(['wild']);
  });
  it('와일드가 무늬를 맞춰 플러시 (없는 가장 높은 숫자로)', () => {
    const r = evaluatePlayerHand(h('7c Ah'), h('Kh 9h 4h 2s 3d'), { wildRank: 7 });
    expect(r.value.score).toEqual([Category.Flush, 1, 14, 13, 12, 9, 4]);
  });
  it('와일드는 그 숫자 자체로도 쓸 수 있다 (변형 미적용으로 표시)', () => {
    const r = evaluatePlayerHand(h('7c 8d'), h('5h 6d 9s Kc 2h'), { wildRank: 7 });
    // 5-6-7-8-9 자연 스트레이트보다 와일드로 더 좋은 패가 없으면 미적용
    expect(r.value.score).toEqual([Category.Straight, 9, 1]);
    expect(r.applied).toEqual([]);
  });
  it('와일드 + 4장 플러시 + 징검다리가 겹치면 가장 높은 족보', () => {
    const rules = { wildRank: 7, fourFlush: true, gapStraight: true };
    const r = evaluatePlayerHand(h('7c 5h'), h('6h 9h Th Ks 2d'), rules);
    expect(r.value.score).toEqual([Category.StraightFlush, 10, 0]);
    expect(r.applied).toContain('gapStraight');
    expect(r.applied).toContain('wild');
    // 징검다리 없이 와일드만이면 5장 플러시
    expect(evaluatePlayerHand(h('7c 5h'), h('6h 9h Th Ks 2d'), { wildRank: 7 }).value.score).toEqual([
      Category.Flush, 1, 14, 10, 9, 6, 5,
    ]);
    // 와일드 없이 4장 플러시만이면 4장 플러시
    expect(evaluatePlayerHand(h('7c 5h'), h('6h 9h Th Ks 2d'), { fourFlush: true }).value.score[0]).toBe(Category.Flush);
  });
  it('보유하지 않은 사람에게는 와일드가 아님', () => {
    expect(evaluatePlayerHand(h('7c 7d'), h('As Ad Kc 2h 9s'), {}).value.category).toBe(Category.TwoPair);
  });
  it('와일드 4장 + 아무 카드 → 파이브 카드', () => {
    expect(best('7c 7d 7h 7s 2c 3d 9h', { wildRank: 7 }).score).toEqual([Category.FiveKind, 9]);
  });
});

describe('족보 핵심 카드 (화면 강조용)', () => {
  const core = (cards: string, rules = {}) => [...best(cards, rules).core].sort();
  it('같은 숫자 계열은 그 숫자 카드만, 키커 제외', () => {
    expect(core('Ac Ad 9h 7s 4c 3d 2h')).toEqual(['Ac', 'Ad']);
    expect(core('Kc Kd 7h 7s Ac 2d 3h')).toEqual(['7h', '7s', 'Kc', 'Kd']);
    expect(core('7c 7d 7h Ks 2c 9d 4h')).toEqual(['7c', '7d', '7h']);
    expect(best('Ac Ad 9h 7s 4c 3d 2h').cards).toHaveLength(5);
  });
  it('하이카드는 가장 높은 1장, 5장 족보는 5장 모두', () => {
    expect(core('Ac Jd 9h 7s 4c 3d 2h')).toEqual(['Ac']);
    expect(core('9c 8d 7h 6s 5c Kd 2h')).toEqual(['5c', '6s', '7h', '8d', '9c']);
  });
  it('4장 플러시는 같은 무늬 4장, 와일드는 핵심에 포함', () => {
    expect(core('Ah 9h Kh 2h Qs Jc 5d', { fourFlush: true })).toEqual(['2h', '9h', 'Ah', 'Kh']);
    expect(core('7c 7d As Ad Kc 2h 9s', { wildRank: 7 })).toEqual(['7c', '7d', 'Ad', 'As']);
  });
});

describe('원형 스트레이트 (보유자에게만)', () => {
  const rules = { wrapStraight: true };
  it('A를 넘어 이어지는 스트레이트, 끝 카드로 비교', () => {
    expect(best('Qc Kd Ah 2s 3c', rules).score).toEqual([Category.Straight, 3, 1]);
    expect(best('Jc Qd Kh As 2c', rules).score).toEqual([Category.Straight, 2, 1]);
    expect(best('Kc Ad 2h 3s 4c', rules).score).toEqual([Category.Straight, 4, 1]);
    expect(best('Qc Kd Ah 2s 3c', rules).name).toBe('원형 스트레이트 (3 하이)');
  });
  it('원형은 휠(5 하이)보다 낮고, 보유하지 않으면 스트레이트가 아님', () => {
    expect(compareScores(best('Ac 2d 3h 4s 5c').score, best('Kc Ad 2h 3s 4c', rules).score)).toBeGreaterThan(0);
    expect(best('Qc Kd Ah 2s 3c').category).toBe(Category.HighCard);
  });
  it('일반 스트레이트는 그대로', () => {
    expect(best('9c Td Jh Qs Kc', rules).score).toEqual([Category.Straight, 13, 1]);
    const r = evaluatePlayerHand(h('Ah 3c'), h('Qd Kc 2h 9s 6d'), rules);
    expect(r.applied).toEqual(['wrapStraight']);
  });
  it('징검다리와 함께면 원형 징검다리도 인정', () => {
    expect(best('Kc Ad 2h 3s 5c', { wrapStraight: true, gapStraight: true }).score).toEqual([Category.Straight, 5, 0]);
  });
});
