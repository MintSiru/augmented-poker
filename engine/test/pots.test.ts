import { describe, expect, it } from 'vitest';
import { computePots, splitPot } from '../src/pots.js';

const c = (id: string, contributed: number, folded = false) => ({ id, contributed, folded });

describe('사이드팟 계산', () => {
  it('올인 금액이 다른 세 명', () => {
    const pots = computePots([c('A', 100), c('B', 300), c('C', 300)]);
    expect(pots).toEqual([
      { amount: 300, eligible: ['A', 'B', 'C'] },
      { amount: 400, eligible: ['B', 'C'] },
    ]);
  });

  it('네 단계의 다중 사이드팟', () => {
    const pots = computePots([c('A', 50), c('B', 120), c('C', 300), c('D', 500), c('E', 500)]);
    expect(pots).toEqual([
      { amount: 250, eligible: ['A', 'B', 'C', 'D', 'E'] },
      { amount: 280, eligible: ['B', 'C', 'D', 'E'] },
      { amount: 540, eligible: ['C', 'D', 'E'] },
      { amount: 400, eligible: ['D', 'E'] },
    ]);
    expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(1470);
  });

  it('폴드한 플레이어의 칩은 자격 없이 해당 구간 팟에 들어간다', () => {
    const pots = computePots([c('A', 100), c('B', 300), c('C', 300), c('D', 200, true)]);
    expect(pots).toEqual([
      { amount: 400, eligible: ['A', 'B', 'C'] },
      { amount: 500, eligible: ['B', 'C'] },
    ]);
  });

  it('멀리건 비용(데드 머니)은 메인팟으로', () => {
    const pots = computePots([c('A', 100), c('B', 300), c('C', 300)], 40);
    expect(pots[0].amount).toBe(340);
  });

  it('모두 같은 금액이면 팟 하나', () => {
    expect(computePots([c('A', 200), c('B', 200), c('C', 50, true)])).toEqual([{ amount: 450, eligible: ['A', 'B'] }]);
  });
});

describe('팟 분배', () => {
  it('나누어떨어지지 않는 칩은 딜러 왼쪽에 가까운 승자부터', () => {
    const m = splitPot(101, ['B', 'A']);
    expect(m.get('B')).toBe(51);
    expect(m.get('A')).toBe(50);
    const m3 = splitPot(100, ['A', 'B', 'C']);
    expect([m3.get('A'), m3.get('B'), m3.get('C')]).toEqual([34, 33, 33]);
  });
});
