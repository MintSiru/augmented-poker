// 메인팟/사이드팟 계산과 분배

export interface PotContribution {
  id: string;
  /** 이번 핸드에 팟에 넣은 총액 */
  contributed: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** 이 팟을 가져갈 자격이 있는(폴드하지 않은) 플레이어 */
  eligible: string[];
}

/**
 * 기여액 구간별로 팟을 나눈다.
 * - 폴드하지 않은 플레이어들의 기여액을 오름차순 단계로 삼아, 각 단계까지 모든 플레이어가 낸 금액을 모은다.
 * - 폴드한 플레이어의 칩은 자격 없이 해당 구간 팟에 들어간다.
 * - deadMoney(멀리건 비용 등)는 메인팟에 더한다.
 */
export function computePots(players: PotContribution[], deadMoney = 0): Pot[] {
  const live = players.filter((p) => !p.folded);
  const levels = [...new Set(live.map((p) => p.contributed).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const p of players) amount += Math.min(p.contributed, level) - Math.min(p.contributed, prev);
    const eligible = live.filter((p) => p.contributed >= level).map((p) => p.id);
    if (amount > 0) {
      const last = pots[pots.length - 1];
      if (last && sameSet(last.eligible, eligible)) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    prev = level;
  }
  // 살아 있는 누구보다 많이 낸 폴드 칩(이론상 드묾)은 마지막 팟으로
  let leftover = 0;
  for (const p of players) leftover += Math.max(0, p.contributed - prev);
  if (leftover > 0) {
    if (pots.length) pots[pots.length - 1].amount += leftover;
    else pots.push({ amount: leftover, eligible: live.map((p) => p.id) });
  }
  if (deadMoney > 0) {
    if (pots.length) pots[0].amount += deadMoney;
    else pots.push({ amount: deadMoney, eligible: live.map((p) => p.id) });
  } else if (deadMoney < 0) {
    // 팟에서 미리 꺼내 간 칩(예약 주문 등): 메인팟부터 뺀다
    let debt = -deadMoney;
    for (const pot of pots) {
      const take = Math.min(debt, pot.amount);
      pot.amount -= take;
      debt -= take;
    }
  }
  return pots;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * 팟 하나를 승자들에게 나눈다. 나누어떨어지지 않는 칩은 딜러 왼쪽에 가장 가까운 승자에게 모두 준다.
 * @param winnersInOrder 딜러 왼쪽부터의 좌석 순서로 정렬된 승자 id
 */
export function splitPot(amount: number, winnersInOrder: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = winnersInOrder.length;
  const share = Math.floor(amount / n);
  const rem = amount - share * n;
  winnersInOrder.forEach((id, i) => out.set(id, share + (i === 0 ? rem : 0)));
  return out;
}
