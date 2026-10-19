// 규칙 기반 봇. 사람과 똑같이 자기 PlayerView 만 보고 결정한다 (엔진 상태에 접근하지 않음).
// 핸드 강도는 몬테카를로로 추정하며, 자신의 족보 변형 증강·족보 역전·투시/예지로 얻은 정보를 반영한다.

import { Card, fullDeck, RANK_CHARS, rankOf } from './cards.js';
import { ALL_AUGMENT_IDS, AugmentId } from './augments.js';
import { bestHand, compareScores, EvalRules } from './evaluator.js';
import { Rng, pickOne, shuffle } from './rng.js';
import type { GameAction } from './types.js';
import type { MyAugmentView, PlayerView } from './view.js';

function rankFromName(name: string | null): number | null {
  if (!name) return null;
  if (name === '10') return 10;
  const i = RANK_CHARS.indexOf(name);
  return i >= 0 ? i + 2 : null;
}

function myRules(view: PlayerView): EvalRules {
  const has = (id: AugmentId) => view.you.augments.some((a) => a.id === id);
  const fav = view.you.augments.find((a) => a.id === 'favoritism');
  return {
    fourFlush: has('fourFlush'),
    gapStraight: has('gapStraight'),
    wrapStraight: has('wrapStraight'),
    wildRank: rankFromName(fav?.wildRank ?? null),
    fourStraight: has('fourStraight'),
    doubleStep: has('doubleStep'),
    parity: view.you.augments.find((a) => a.id === 'parity')?.parity ?? null,
  };
}

interface EquityInput {
  hole: Card[];
  /** 내가 보는 보드 (안개로 가려진 칸은 null) */
  board: (Card | null)[];
  /** 족보 계산에서 제외할 보드 인덱스 */
  excluded: number[];
}

/** 몬테카를로 승률 추정 (족보 역전이면 낮은 패가 이긴다) */
export function estimateEquity(view: PlayerView, rng: Rng, input: EquityInput, iterations = 120): number {
  const opponents = view.players.filter((p) => p.id !== view.you.id && p.hasCards);
  if (!opponents.length) return 1;
  if (!input.hole.length) return 1 / (opponents.length + 1);
  const rules = myRules(view);
  const inverted = view.table.inverted;
  const hand = view.handNumber;
  const visibleBoard = input.board.filter((c): c is Card => !!c);
  const known = new Set<Card>([...view.you.hole, ...visibleBoard, ...input.hole]);
  const foreseen = new Map<number, Card>();
  const oppKnown = new Map<string, Card[]>();
  for (const p of opponents) if (p.shownCards) oppKnown.set(p.id, [...p.shownCards]);
  for (const n of view.you.notes) {
    if (n.hand !== hand || !n.cards) continue;
    if (n.kind === 'mulligan' || n.kind === 'discard') n.cards.forEach((c) => known.add(c));
    if (n.kind === 'foresight') {
      const idx = input.board.length;
      if (!input.board.includes(n.cards[0])) foreseen.set(idx, n.cards[0]);
    }
    if ((n.kind === 'clairvoyance' || n.kind === 'mirror') && n.targetId && !oppKnown.has(n.targetId)) oppKnown.set(n.targetId, [n.cards[0]]);
  }
  for (const cs of oppKnown.values()) cs.forEach((c) => known.add(c));
  foreseen.forEach((c) => known.add(c));
  for (const u of view.you.counting?.used ?? []) known.add(u.card);
  const unknown = fullDeck().filter((c) => !known.has(c));
  let score = 0;
  for (let it = 0; it < iterations; it++) {
    const deck = shuffle([...unknown], rng);
    let k = 0;
    const board: Card[] = [];
    for (let i = 0; i < 5; i++) board.push(input.board[i] ?? foreseen.get(i) ?? deck[k++]);
    const evalBoard = board.filter((_, i) => !input.excluded.includes(i));
    const mine = bestHand([...input.hole, ...evalBoard], rules).score;
    let beaten = false;
    let ties = 0;
    for (const o of opponents) {
      const knownCards = oppKnown.get(o.id) ?? [];
      const oh = [...knownCards];
      while (oh.length < 2) oh.push(deck[k++]);
      let cmp = compareScores(mine, bestHand([...oh, ...evalBoard]).score);
      if (inverted) cmp = -cmp;
      if (cmp < 0) {
        beaten = true;
        break;
      }
      if (cmp === 0) ties++;
    }
    if (!beaten) score += ties ? 1 / (ties + 1) : 1;
  }
  return score / iterations;
}

function chance(rng: Rng, pct: number): boolean {
  return rng.int(100) < pct;
}

function usable(view: PlayerView, id: AugmentId): MyAugmentView | undefined {
  return view.you.augments.find((a) => a.id === id && a.usableNow);
}

function use(id: AugmentId, extra: Partial<Extract<GameAction, { type: 'useAugment' }>> = {}): GameAction {
  return { type: 'useAugment', augment: id, ...extra };
}

/**
 * 내 차례가 아니어도 쓸 만한 증강 (강제 집행, 거짓말 탐지기, 암전, 죽음과 세금).
 * 서버가 결정 상황이 바뀔 때마다 한 번씩 물어본다.
 */
export function chooseBotOpportunistic(view: PlayerView, rng: Rng): GameAction | null {
  if (view.you.out || view.phase === 'gameOver' || view.phase === 'reaction') return null;
  const enf = usable(view, 'enforcement');
  if (enf && enf.targets.length) return use('enforcement', { targetId: pickOne(enf.targets, rng) });
  const lie = usable(view, 'liedetector');
  if (lie && lie.targets.length && chance(rng, 40)) return use('liedetector', { targetId: lie.targets[0] });
  if (usable(view, 'blackout') && chance(rng, 15)) return use('blackout');
  if (usable(view, 'deathTax') && chance(rng, 15)) return use('deathTax');
  // 2차: 핸드 사이에 쓰는 공개형·카드 조작
  if (usable(view, 'bombPot') && chance(rng, 10)) return use('bombPot');
  if (usable(view, 'underdog') && chance(rng, 10)) return use('underdog');
  const dd = usable(view, 'destinyDraw');
  if (dd && chance(rng, 50)) {
    const blocked = new Set(view.you.extra.destinyBlocked);
    const aces = fullDeck().filter((c) => c[0] === 'A' && !blocked.has(c));
    return use('destinyDraw', { card: pickOne(aces, rng) });
  }
  if (usable(view, 'padlock') && chance(rng, 8)) return use('padlock');
  if (usable(view, 'loan') && view.you.chips < view.blinds.bb * 10) return use('loan');
  if (usable(view, 'augShuffle') && chance(rng, 8)) return use('augShuffle');
  const ls = usable(view, 'loanShark');
  if (ls && ls.targets.length && chance(rng, 5)) return use('loanShark', { targetId: pickOne(ls.targets, rng) });
  if (usable(view, 'rumor') && chance(rng, 4)) return use('rumor', { rumor: pickOne(ALL_AUGMENT_IDS, rng) });
  return null;
}

/** 지금 봇이 할 행동 하나. 할 일이 없으면 null. */
export function chooseBotAction(view: PlayerView, rng: Rng): GameAction | null {
  const you = view.you;
  if (you.out || view.phase === 'gameOver') return null;

  // 반응 대기: 카운터 스펠, 면역
  if (view.reaction) {
    if (view.reaction.canCounter && chance(rng, view.reaction.anonymous ? 15 : 35)) return { type: 'counter' };
    if (view.reaction.canImmune && chance(rng, 40)) return { type: 'immunity' };
    return null;
  }

  // 제안·입찰·비공개 선언: 싸면 수락, 입찰은 핸드 강도에 따라 0~3BB, 선언은 정직하게
  const rs = view.respond;
  if (rs && rs.needMe && rs.input) {
    const bb = view.blinds.bb;
    const low = () => {
      const ranks = you.hole.map(rankOf);
      return Math.max(0, ranks.indexOf(Math.min(...ranks)));
    };
    const strength = () => estimateEquity(view, rng, { hole: you.hole, board: view.board, excluded: view.sealed }, 60);
    const bidFor = (eq: number) => {
      const b = Math.min(3, Math.floor(eq * 4)) * bb;
      return b >= bb && b <= you.chips ? b : 0;
    };
    switch (rs.input) {
      case 'accept':
        if (rs.augment === 'pickMe') return { type: 'respond', accept: true };
        if (rs.augment === 'loanShark') return { type: 'respond', accept: you.chips < 15 * bb };
        return { type: 'respond', accept: chance(rng, 50) };
      case 'card':
        return { type: 'respond', cardIndex: low() };
      case 'bid':
        return { type: 'respond', bid: bidFor(strength()) };
      case 'bidCard': {
        const card = view.auctionCard;
        const worth = !!card && card[1] !== '?' && you.hole.length > 0 && rankOf(card) > Math.min(...you.hole.map(rankOf));
        return worth ? { type: 'respond', bid: bidFor(Math.max(0.3, strength())), cardIndex: low() } : { type: 'respond', bid: 0 };
      }
      case 'strongWeak':
        return { type: 'respond', choice: strength() >= 0.5 ? 1 : 0 };
    }
  }

  if (you.pick && you.pick.length) return { type: 'pick', augment: pickOne(you.pick, rng).id };

  // 애착: 높은 카드를 가져간다
  if (you.attach) {
    const ranks = you.attach.cards.map(rankOf);
    return { type: 'attach', cardIndex: ranks.indexOf(Math.max(...ranks)) };
  }

  // 보관함: 높은 카드를 보관, 쇼맨십: 항상 공개
  if (you.extra.lockerChoose) {
    const ranks = you.extra.lockerChoose.map(rankOf);
    return { type: 'locker', cardIndex: ranks.indexOf(Math.max(...ranks)) };
  }
  if (you.extra.showChoose) return { type: 'show', reveal: true };
  // 양자택일: 숫자가 높은 후보
  if (you.extra.eitherOr && you.extra.eitherOr.pick === null) {
    const [a, b] = you.extra.eitherOr.cards.map(rankOf);
    return { type: 'eitherOr', pick: b > a ? 1 : 0 };
  }

  // 세 번째 손: 남길 2장의 승률이 가장 높은 쪽
  if (you.discard?.pending) {
    let best = 0;
    let bestEq = -1;
    for (let i = 0; i < you.hole.length; i++) {
      const keep = you.hole.filter((_, j) => j !== i);
      const eq = estimateEquity(view, rng, { hole: keep, board: view.board, excluded: [] }, 60);
      if (eq > bestEq) {
        bestEq = eq;
        best = i;
      }
    }
    return { type: 'discard', cardIndex: best };
  }

  // 선언 기회 (되감기·봉인·밥상 뒤집기)
  if (you.declare) {
    const opts = you.declare.options.map((o) => o.id);
    const base = estimateEquity(view, rng, { hole: you.hole, board: view.board, excluded: view.sealed }, 80);
    if (opts.includes('flipTable') && you.hand && you.hand.category <= 1 && !view.table.inverted) return { type: 'declare', augment: 'flipTable' };
    if (opts.includes('blackjack') && you.hand && you.hand.category < 6) return { type: 'declare', augment: 'blackjack' };
    if (opts.includes('eitherOr') && chance(rng, 60)) return { type: 'declare', augment: 'eitherOr' };
    if (opts.includes('lastFork') && base < 0.3 && you.hole.length) {
      const ranks = you.hole.map(rankOf);
      return { type: 'declare', augment: 'lastFork', boardIndex: ranks.indexOf(Math.min(...ranks)) };
    }
    if (opts.includes('seal')) {
      let bestIdx: number | null = null;
      let bestEq = base + 0.05;
      for (let i = 0; i < view.board.length; i++) {
        if (view.sealed.includes(i)) continue;
        const eq = estimateEquity(view, rng, { hole: you.hole, board: view.board, excluded: [...view.sealed, i] }, 80);
        if (eq > bestEq) {
          bestEq = eq;
          bestIdx = i;
        }
      }
      if (bestIdx !== null) return { type: 'declare', augment: 'seal', boardIndex: bestIdx };
    }
    if (opts.includes('rewind') && base < 0.3 && chance(rng, 50)) return { type: 'declare', augment: 'rewind' };
    const jt = you.declare.targets.jointTransfer;
    if (opts.includes('jointTransfer') && jt?.length && base < 0.4 && chance(rng, 25)) return { type: 'declare', augment: 'jointTransfer', targetId: pickOne(jt, rng) };
    const ni = you.declare.targets.nameIt;
    if (opts.includes('nameIt') && ni?.length && chance(rng, 5)) {
      const seen = new Set<Card>([...you.hole, ...view.board.filter((c): c is Card => !!c)]);
      return { type: 'declare', augment: 'nameIt', targetId: pickOne(ni, rng), card: pickOne(fullDeck().filter((c) => c[0] === 'A' && !seen.has(c)), rng) };
    }
    return { type: 'declare', augment: null };
  }

  // 토글형 증강은 미리 켜 둔다
  for (const a of you.augments) {
    if (a.id === 'exemption' && !a.armed && (a.usesLeft ?? 0) > 0) return use('exemption', { on: true });
    if (a.id === 'disguise' && !a.fakeId && (a.usesLeft ?? 0) > 0) {
      const fakes = ALL_AUGMENT_IDS.filter((id) => id !== 'disguise' && !you.augments.some((x) => x.id === id));
      return use('disguise', { fakeId: pickOne(fakes, rng) });
    }
  }

  const opp = chooseBotOpportunistic(view, rng);
  if (opp) return opp;

  const legal = you.legal;
  if (!legal) return null;

  const live = view.players.filter((p) => p.id !== you.id && p.hasCards);
  const eq = estimateEquity(view, rng, { hole: you.hole, board: view.board, excluded: view.sealed });

  // 내 차례에 쓰는 증강 (2차)
  const lr = you.extra.lockerReady;
  if (lr && you.hole.length) {
    const ranks = you.hole.map(rankOf);
    if (rankOf(lr) > Math.min(...ranks)) return { type: 'locker', cardIndex: ranks.indexOf(Math.min(...ranks)) };
  }
  if (usable(view, 'bet') && you.extra.betPrediction === null) return use('bet', { choice: 2 });
  if (usable(view, 'ironWall') && chance(rng, 30)) return use('ironWall');
  if (usable(view, 'circuitBreaker') && eq < 0.3) return use('circuitBreaker');
  if (usable(view, 'restart') && view.pot >= you.chips * 0.5 && (!you.hand || you.hand.category <= 1) && chance(rng, 50)) return use('restart');
  const dart = usable(view, 'blindDart');
  if (dart && dart.targets.length && chance(rng, 20)) return use('blindDart', { targetId: pickOne(dart.targets, rng) });
  const out = usable(view, 'getOut');
  if (out && out.targets.length && eq > 0.3 && chance(rng, 25)) return use('getOut', { targetId: pickOne(out.targets, rng) });
  if (usable(view, 'highCardDuel') && you.hole.some((c) => c[0] === 'A') && chance(rng, 50)) return use('highCardDuel');
  const tm = usable(view, 'thermometer');
  if (tm && tm.targets.length && chance(rng, 20)) return use('thermometer', { targetId: pickOne(tm.targets, rng) });
  if (usable(view, 'radar') && chance(rng, 15)) return use('radar', { boardIndex: view.board.findIndex((c) => !!c) });
  if (usable(view, 'colorForecast') && chance(rng, 30)) return use('colorForecast');
  if (usable(view, 'leaderboard') && chance(rng, 40)) return use('leaderboard');
  if (usable(view, 'blindDraw') && eq < 0.3 && you.hole.length) {
    const ranks = you.hole.map(rankOf);
    return use('blindDraw', { cardIndex: ranks.indexOf(Math.min(...ranks)) });
  }

  // 내 차례에 쓰는 증강
  if (usable(view, 'mulligan') && view.street === 'preflop' && eq < 0.8 / (live.length + 1) && you.chips > view.blinds.bb * 8) {
    const ranks = you.hole.map((c) => RANK_CHARS.indexOf(c[0]));
    return use('mulligan', { cardIndex: you.hole.length ? ranks.indexOf(Math.min(...ranks)) : 0 });
  }
  if (usable(view, 'foresight') && chance(rng, 60)) return use('foresight');
  const cl = usable(view, 'clairvoyance');
  if (cl && cl.targets.length && view.street !== 'preflop' && chance(rng, 50)) return use('clairvoyance', { targetId: pickOne(cl.targets, rng) });
  const th = usable(view, 'thermal');
  if (th && th.targets.length && chance(rng, 25)) return use('thermal', { targetId: pickOne(th.targets, rng) });
  const inq = usable(view, 'inquiry');
  if (inq && inq.targets.length && chance(rng, 5)) return use('inquiry', { targetId: pickOne(inq.targets, rng) });
  if (usable(view, 'blank') && chance(rng, 6)) return use('blank');
  if (usable(view, 'heavyFog') && chance(rng, 15)) return use('heavyFog');
  if (usable(view, 'glassTable') && eq > 0.6 && chance(rng, 15)) return use('glassTable');
  if (usable(view, 'russianRoulette') && eq < 0.25 && chance(rng, 30)) return use('russianRoulette');
  if (usable(view, 'shepherd') && you.hole.length && chance(rng, 12)) {
    const sh = usable(view, 'shepherd')!;
    if (!sh.fakeUsed && chance(rng, 30)) {
      const seen = new Set<Card>([...you.hole, ...view.board.filter((c): c is Card => !!c), ...view.players.flatMap((p) => [...p.shepherdShown, ...(p.shownCards ?? [])])]);
      const aces = fullDeck().filter((c) => c[0] === 'A' && !seen.has(c));
      if (aces.length) return use('shepherd', { card: pickOne(aces, rng) });
    }
    const ranks = you.hole.map(rankOf);
    return use('shepherd', { cardIndex: ranks.indexOf(Math.max(...ranks)) });
  }

  // 3차: 제안·입찰
  const pm = usable(view, 'pickMe');
  if (pm && pm.targets.length && chance(rng, 12)) {
    const ranks = you.hole.map(rankOf);
    return use('pickMe', { targetId: pickOne(pm.targets, rng), cardIndex: Math.max(0, ranks.indexOf(Math.min(...ranks))) });
  }
  if (usable(view, 'infoAuction') && chance(rng, 15)) return use('infoAuction');
  if (usable(view, 'cardAuction') && chance(rng, 15)) return use('cardAuction');
  if (usable(view, 'truthGame') && you.hand && chance(rng, 40)) return use('truthGame', { choice: Math.min(7, you.hand.category) });
  const sd = usable(view, 'staredown');
  if (sd && sd.targets.length && chance(rng, 20)) return use('staredown', { targetId: pickOne(sd.targets, rng) });
  if (usable(view, 'sealedContract') && chance(rng, 30)) return use('sealedContract', { choice: eq > 0.6 ? 1 : 0 });

  // 베팅 결정: 핸드 강도(증강·역전 반영) · 팟 오즈 · 남은 인원
  const opp2 = Math.max(1, live.length);
  const toCall = legal.call ? legal.callAmount : 0;
  const potOdds = toCall > 0 ? toCall / (view.pot + toCall) : 0;
  const strong = Math.min(0.85, 1 / (opp2 + 1) + 0.22);
  const bluff = chance(rng, 8);
  const bb = view.blinds.bb;

  const raiseTo = (fraction: number): GameAction => {
    const desired = view.currentBet + Math.max(bb * 2, Math.round(view.pot * fraction));
    const target = Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, desired));
    if (target >= legal.maxRaiseTo * 0.9) return { type: 'allin' };
    return { type: 'raise', amount: target };
  };
  const call = (): GameAction => (legal.freeRide && chance(rng, 70) ? { type: 'call', freeRide: true } : { type: 'call' });

  if (legal.forced) return legal.check ? { type: 'check' } : call();
  if (legal.check) {
    if (legal.raise && eq > strong) return raiseTo(0.5 + rng.int(50) / 100);
    if (legal.raise && bluff) return raiseTo(0.5);
    return { type: 'check' };
  }
  const allInCall = toCall >= you.chips;
  if (legal.raise && eq > strong + 0.1 && chance(rng, 70)) return raiseTo(0.75);
  if (eq >= potOdds + (allInCall ? 0.08 : 0.02)) return call();
  if (legal.raise && bluff && chance(rng, 30)) return raiseTo(0.6);
  return { type: 'fold' };
}
