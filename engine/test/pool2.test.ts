// 2차 풀 증강 33개(죽음과 세금 포함)와 바뀐 공통 규칙 테스트
import { describe, expect, it } from 'vitest';
import {
  createGame,
  applyAction,
  applyTimeouts,
  getPending,
  startNextHand,
  debugGiveAugment,
  debugSetNextDeal,
  getPlayerView,
  legalActions,
  seededRng,
  rollAugmentOffer,
  canHold,
  evaluatePlayerHand,
  blackjackCards,
  applyBlackjack,
  Category,
  AUGMENTS,
  ALL_AUGMENT_IDS,
  type AugmentId,
  type DebugDeal,
  type GameAction,
  type GameState,
} from '../src/index.js';
import { expectedChips, makePlayers, playGame, totalChips } from './helpers.js';

interface SetupOpts {
  dealer?: number;
  augs?: Record<string, AugmentId[]>;
  deal?: DebugDeal;
  chips?: number[];
  seed?: number;
  /** 첫 핸드 시작 전 (핸드 사이 상태)에 실행 */
  before?: (s: GameState) => void;
}

function ok(r: { ok: boolean; error?: string }) {
  if (!r.ok) throw new Error(r.error);
}

/** 증강·칩·카드를 지정한 뒤 첫 핸드를 시작한다. 기본: p1 딜러 (3인: p2 SB, p3 BB, p1 먼저) */
function setup(n: number, o: SetupOpts = {}): GameState {
  const state = createGame(
    makePlayers(n).map((p) => ({ ...p, isBot: false })),
    { rng: seededRng(o.seed ?? 42), debug: true, initialPick: false, dealerSeat: o.dealer ?? 0, handsPerLevel: 1000 },
  );
  for (const [id, list] of Object.entries(o.augs ?? {})) for (const a of list) ok(debugGiveAugment(state, id, a));
  o.chips?.forEach((c, i) => (state.players[i].chips = c));
  if (o.deal) ok(debugSetNextDeal(state, o.deal));
  o.before?.(state);
  resolveAll(state);
  ok(startNextHand(state));
  resolveAll(state);
  return state;
}

const act = (s: GameState, id: string, a: GameAction) => ok(applyAction(s, id, a));
const use = (s: GameState, id: string, augment: AugmentId, extra: Record<string, unknown> = {}) =>
  act(s, id, { type: 'useAugment', augment, ...extra } as GameAction);
const tryUse = (s: GameState, id: string, augment: AugmentId, extra: Record<string, unknown> = {}) =>
  applyAction(s, id, { type: 'useAugment', augment, ...extra } as GameAction);
const P = (s: GameState, id: string) => s.players.find((p) => p.id === id)!;
const toAct = (s: GameState) => getPending(s).playerIds[0];
const cards = (x: string) => x.split(' ');
const view = (s: GameState, id: string) => getPlayerView(s, id);
const lastNote = (s: GameState, id: string) => P(s, id).notes.at(-1)!.text;

function resolveAll(s: GameState) {
  for (let i = 0; i < 20 && s.phase === 'reaction'; i++) applyTimeouts(s);
}

/** 지금 차례인 사람이 체크(가능하면) 또는 콜, 선언 기회는 넘기기, 반응 대기는 끝내기를 반복 */
function passUntil(s: GameState, pred: () => boolean, limit = 80) {
  for (let i = 0; i < limit && !pred(); i++) {
    const pend = getPending(s);
    if (pend.kind === 'reaction') {
      applyTimeouts(s);
      continue;
    }
    const id = pend.playerIds[0];
    if (pend.kind === 'declare') act(s, id, { type: 'declare', augment: null });
    else if (pend.kind === 'discard') act(s, id, { type: 'discard', cardIndex: 0 });
    else if (pend.kind === 'turn') {
      const l = legalActions(s, id)!;
      act(s, id, l.check ? { type: 'check' } : { type: 'call' });
    } else break;
  }
  if (!pred()) throw new Error(`condition not reached (phase ${s.phase}, street ${s.street})`);
}

const toShowdown = (s: GameState) => passUntil(s, () => s.phase === 'handEnd' || s.phase === 'gameOver');
const BOARD = 'As Kd 7c 4h 2s';

// ───────────────────────── 보유 규칙 ─────────────────────────

describe('보유 규칙 (배타적 풀 5종, 카운터형 8종)', () => {
  const variant: AugmentId[] = ['fourFlush', 'gapStraight', 'fourStraight', 'parity', 'doubleStep'];
  const counter: AugmentId[] = ['disinfo', 'vest', 'mirror', 'counterSpell', 'traceback', 'ironWall', 'immunity', 'padlock'];

  it('배타적 풀은 5종 중 1개, 카운터형은 8종 중 1개만', () => {
    for (const a of variant) for (const b of variant) if (a !== b) expect(canHold([a], b)).toBe(false);
    for (const a of counter) for (const b of counter) if (a !== b) expect(canHold([a], b)).toBe(false);
    expect(canHold(['parity'], 'traceback')).toBe(true);
    expect(variant.every((id) => AUGMENTS[id].group === 'variant')).toBe(true);
    expect(counter.every((id) => AUGMENTS[id].group === 'counter')).toBe(true);
    // 3차 풀에서 탈취·공개 청문회가 더해져 10종
    expect(ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].group === 'counter').sort()).toEqual([...counter, 'steal', 'publicHearing'].sort());
  });

  it('보유할 수 없는 증강은 선택지에서 빠진다', () => {
    const rng = seededRng(3);
    for (let i = 0; i < 400; i++) {
      const owned: AugmentId[] = ['doubleStep', 'padlock'];
      const offer = rollAugmentOffer(1 + (i % 6), owned, rng);
      expect(offer.some((id) => variant.includes(id) || counter.includes(id))).toBe(false);
    }
  });

  it('정보형 비공개 알림 목록에 온도계·레이더·색채 예보·순위표, 블랙잭도 이름 비공개, 데스티니 드로우는 이름 공개', () => {
    for (const id of ['thermometer', 'radar', 'colorForecast', 'leaderboard', 'blackjack', 'bet'] as AugmentId[]) expect(AUGMENTS[id].disclosure).toBe('anonymous');
    expect(AUGMENTS.destinyDraw.disclosure).toBe('named');
    expect(AUGMENTS.rumor.disclosure).toBe('secret');
  });
});

// ───────────────────────── 족보 변형 ─────────────────────────

describe('족보 변형: 보폭 두 배, 4장 스트레이트, 짝수/홀수 동맹, 블랙잭', () => {
  const ev = (hole: string, board: string, rules: Record<string, unknown>) => evaluatePlayerHand(cards(hole), cards(board), rules);

  it('보폭 두 배: 2씩 증가하는 5장 (A는 1로만), 같은 최고 숫자면 일반 스트레이트가 높다', () => {
    const r = ev('2c 4d', '6h 8s Tc Kd Kh', { doubleStep: true });
    expect(r.value.score).toEqual([Category.Straight, 10, 0]);
    expect(r.applied).toEqual(['doubleStep']);
    expect(r.value.name).toContain('보폭 두 배');
    expect(ev('Ac 3d', '5h 7s 9c Kd Qh', { doubleStep: true }).value.score).toEqual([Category.Straight, 9, 0]);
    // A를 14로 쓰는 Q-...-A 는 안 됨 (6-8-T-Q-A)
    expect(ev('6c 8d', 'Th Qs Ac 2d 3h', { doubleStep: true }).value.category).toBe(Category.HighCard);
    const normal = ev('6c 7d', '8h 9s Tc 2d 2h', {}).value.score;
    expect(normal).toEqual([Category.Straight, 10, 1]);
    // 스트레이트 플러시에는 적용하지 않는다 (같은 무늬면 플러시)
    expect(ev('2h 4h', '6h 8h Th Kd Kc', { doubleStep: true }).value.category).toBe(Category.Flush);
  });

  it('4장 스트레이트: 연속 4장 + 1장, 4장의 최고 숫자로 비교, 같으면 일반 스트레이트가 높다', () => {
    const r = ev('5c 6d', '7h 8s Kc 2d 2h', { fourStraight: true });
    expect(r.value.score).toEqual([Category.Straight, 8, 0]);
    expect(r.applied).toEqual(['fourStraight']);
    expect(ev('5c 6d', '7h 8s 9c 2d 2h', { fourStraight: true }).value.score).toEqual([Category.Straight, 9, 1]);
    // 스트레이트 플러시에는 적용하지 않는다
    expect(ev('5h 6h', '7h 8h Kh 2d 3c', { fourStraight: true }).value.category).toBe(Category.Flush);
    // 원형 스트레이트와 겹치면 A를 넘는 4장도
    expect(ev('Kc Ad', '2h 3s 9c 9d 5h', { fourStraight: true, wrapStraight: true }).value.score).toEqual([Category.Straight, 3, 0]);
  });

  it('짝수/홀수 동맹: 5장이 모두 고른 쪽 숫자면 동맹 플러시 (A 제외), 완전히 같으면 일반 플러시가 높다', () => {
    const r = ev('2c 4d', '8h Qs Tc 3d 5h', { parity: 'even' });
    expect(r.value.score).toEqual([Category.Flush, 1, 12, 10, 8, 4, 2, 0]);
    expect(r.applied).toEqual(['parity']);
    expect(r.value.name).toContain('동맹 플러시');
    expect(ev('3c 5d', '7h 9s Jc 2d 4h', { parity: 'odd' }).value.score[0]).toBe(Category.Flush);
    expect(ev('3c 5d', '7h 9s Ac 2d 4h', { parity: 'odd' }).value.category).not.toBe(Category.Flush);
    const real = ev('2h 4h', '8h Qh Th 3d 5c', {}).value.score;
    expect(real).toEqual([Category.Flush, 1, 12, 10, 8, 4, 2, 1]);
    // 4장 플러시보다는 높다
    expect(ev('2h 4h', '8h Qh 9c 3d 5c', { fourFlush: true }).value.score[1]).toBe(0);
    // 편애 와일드와 겹치면 와일드가 가장 높은 짝수(Q)로
    expect(ev('2c 7d', '8h Qs Tc 3d 5h', { parity: 'even', wildRank: 7 }).value.score.slice(0, 3)).toEqual([Category.Flush, 1, 12]);
  });

  it('블랙잭: 5장 숫자 합 21이면 가장 낮은 풀하우스와 동급, 원래 족보가 높으면 원래 족보', () => {
    expect(blackjackCards(cards('Kd Ah 5c 3d 2h 9s 8s'))).not.toBeNull();
    expect(blackjackCards(cards('Kd Qh Jc Td 9h 8s 7s'))).toBeNull();
    const base = ev('Kd Ah', '5c 3d 2h 9s 8s', {});
    const bj = applyBlackjack(base, cards('Kd Ah 5c 3d 2h 9s 8s'));
    expect(bj.value.score).toEqual([Category.FullHouse, 2, 3]);
    expect(bj.applied).toEqual(['blackjack']);
    // 원래 포카드면 그대로
    const quads = ev('9d 9h', '9c 9s 2h Ad Kc', {});
    expect(applyBlackjack(quads, cards('9d 9h 9c 9s 2h Ad Kc')).value.category).toBe(Category.Quads);
  });
});

// ───────────────────────── 정보형 ─────────────────────────

describe('2차 정보형', () => {
  it('온도계: 숫자 합 15 이상/미만만, 핸드당 1회, 이름 없는 알림, 역추적은 누가 무엇을 썼는지 알림', () => {
    const s = setup(3, { augs: { p1: ['thermometer'], p2: ['traceback', 'thermal'] }, deal: { hands: { p2: cards('Ks 6d'), p3: cards('2c 3c') } } });
    use(s, 'p1', 'thermometer', { targetId: 'p2' });
    expect(view(s, 'p3').log.at(-1)!.text).toBe('P1님이 비공개 증강을 사용했습니다');
    resolveAll(s);
    expect(lastNote(s, 'p1')).toContain('15 이상');
    expect(lastNote(s, 'p2')).toBe('역추적: P1이(가) 나에게 「온도계」을(를) 썼습니다.');
    expect(tryUse(s, 'p1', 'thermometer', { targetId: 'p3' }).ok).toBe(false); // 핸드당 1회
  });

  it('레이더: 보드 카드와 같은 숫자의 홀카드를 가진 상대 수만 (프리플랍엔 불가)', () => {
    const s = setup(3, { augs: { p1: ['radar'] }, deal: { board: cards(BOARD), hands: { p1: cards('9c 9d'), p2: cards('Ad 3c'), p3: cards('Qc Jh') } } });
    expect(tryUse(s, 'p1', 'radar', { boardIndex: 0 }).ok).toBe(false);
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'radar', { boardIndex: 0 });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toContain('상대 1명');
    expect(P(s, 'p1').augments[0].usesLeft).toBe(2);
  });

  it('색채 예보: 플랍·턴의 내 행동 직전에 다음 보드 카드의 무늬만', () => {
    const s = setup(3, { augs: { p2: ['colorForecast'] }, deal: { board: cards(BOARD) } });
    expect(tryUse(s, 'p2', 'colorForecast').ok).toBe(false); // 프리플랍
    passUntil(s, () => s.street === 'flop');
    expect(toAct(s)).toBe('p2');
    use(s, 'p2', 'colorForecast');
    resolveAll(s);
    expect(lastNote(s, 'p2')).toBe('색채 예보: 다음 보드 카드(턴)의 무늬는 ♥ 하트');
    expect(P(s, 'p2').notes.at(-1)!.cards).toBeUndefined();
  });

  it('순위표: 턴 이후, 남은 사람 중 내 등수 (동점은 같은 등수)', () => {
    const s = setup(3, { augs: { p3: ['leaderboard'] }, deal: { board: cards(BOARD), hands: { p1: cards('Ah Ac'), p2: cards('Kc Kh'), p3: cards('7d 7h') } } });
    passUntil(s, () => s.street === 'flop');
    expect(tryUse(s, 'p3', 'leaderboard').ok).toBe(false);
    passUntil(s, () => s.street === 'turn');
    use(s, 'p3', 'leaderboard');
    resolveAll(s);
    expect(lastNote(s, 'p3')).toBe('순위표: 남은 3명 중 3등');
  });
});

// ───────────────────────── 카드 조작형 ─────────────────────────

describe('2차 카드 조작형', () => {
  it('데스티니 드로우: 핸드 사이에 고른 카드를 다음 핸드 홀카드로, 다른 사람이 가져온 카드는 불가', () => {
    const s = setup(3, {
      augs: { p1: ['destinyDraw'] },
      before: (st) => {
        st.players[1].keptCard = 'Kh';
        expect(tryUse(st, 'p1', 'destinyDraw', { card: 'Kh' }).ok).toBe(false);
        use(st, 'p1', 'destinyDraw', { card: 'As' });
        // 이름은 공개, 고른 카드는 비공개
        expect(getPlayerView(st, 'p2').log.some((e) => e.text.includes('데스티니 드로우'))).toBe(true);
        expect(JSON.stringify(getPlayerView(st, 'p2'))).not.toContain('As');
      },
    });
    expect(P(s, 'p1').hole).toContain('As');
    expect(P(s, 'p2').hole).toContain('Kh');
    expect(s.board.concat(s.deck)).not.toContain('As');
  });

  it('보관함: 폴드할 때 1장 보관 → 다음 핸드 프리플랍에 교체, 보관 카드는 덱에서 제외', () => {
    const s = setup(3, { augs: { p1: ['locker'] }, deal: { hands: { p1: cards('Ah 2c') } } });
    act(s, 'p1', { type: 'fold' });
    toShowdown(s);
    expect(view(s, 'p1').you.extra.lockerChoose).toEqual(['Ah', '2c']);
    act(s, 'p1', { type: 'locker', cardIndex: 0 });
    ok(startNextHand(s));
    resolveAll(s);
    const all = [...s.board, ...s.burns, ...s.deck, ...s.players.flatMap((p) => p.hole)];
    expect(all).not.toContain('Ah');
    expect(view(s, 'p1').you.extra.lockerReady).toBe('Ah');
    act(s, 'p1', { type: 'locker', cardIndex: 1 });
    expect(P(s, 'p1').hole).toContain('Ah');
  });

  it('보관함: 바꾸지 않으면 플랍에서 사라진다', () => {
    const s = setup(3, { augs: { p1: ['locker'] }, deal: { hands: { p1: cards('Ah 2c') } } });
    act(s, 'p1', { type: 'fold' });
    toShowdown(s);
    act(s, 'p1', { type: 'locker', cardIndex: 0 });
    ok(startNextHand(s));
    passUntil(s, () => s.street === 'flop');
    expect(P(s, 'p1').lockerReady).toBeNull();
    expect(applyAction(s, 'p1', { type: 'locker', cardIndex: 0 }).ok).toBe(false);
  });

  it('블라인드 드로우: 턴 이후 홀카드 1장을 덱 맨 위 카드로 (나만 봄)', () => {
    const s = setup(3, { augs: { p2: ['blindDraw'] }, deal: { board: cards(BOARD), hands: { p2: cards('3c 5d') }, deck: ['Qh'] } });
    passUntil(s, () => s.street === 'flop');
    expect(tryUse(s, 'p2', 'blindDraw', { cardIndex: 0 }).ok).toBe(false);
    passUntil(s, () => s.street === 'turn');
    use(s, 'p2', 'blindDraw', { cardIndex: 0 });
    resolveAll(s);
    expect(P(s, 'p2').hole).toEqual(['Qh', '5d']);
    expect(JSON.stringify(view(s, 'p3'))).not.toContain('Qh');
  });

  it('양자택일: 플랍 직후 턴 후보 2장 중 고른 카드가 턴에 공개되고 나머지는 버림', () => {
    const s = setup(3, { augs: { p1: ['eitherOr'] }, deal: { board: cards(BOARD), deck: ['Qh'] } });
    passUntil(s, () => s.phase === 'declare');
    expect(s.street).toBe('flop');
    act(s, 'p1', { type: 'declare', augment: 'eitherOr' });
    expect(view(s, 'p3').log.some((e) => e.text.includes('양자택일'))).toBe(true);
    resolveAll(s);
    expect(view(s, 'p1').you.extra.eitherOr).toEqual({ cards: ['4h', 'Qh'], pick: null });
    expect(JSON.stringify(view(s, 'p2'))).not.toContain('Qh');
    act(s, 'p1', { type: 'eitherOr', pick: 1 });
    passUntil(s, () => s.street === 'turn');
    expect(s.board[3]).toBe('Qh');
    expect(s.used.some((u) => u.card === '4h')).toBe(true);
  });

  it('마지막 갈림길: 리버 직후 홀카드 1장을 공개하고 버린 뒤 새 카드 (새 카드는 나만)', () => {
    const s = setup(3, { augs: { p1: ['lastFork'] }, deal: { board: cards(BOARD), hands: { p1: cards('2c 3d') }, deck: ['Qh'] } });
    passUntil(s, () => s.phase === 'declare' && s.street === 'river');
    act(s, 'p1', { type: 'declare', augment: 'lastFork', boardIndex: 0 });
    resolveAll(s);
    expect(P(s, 'p1').hole).toEqual(['Qh', '3d']);
    const v3 = view(s, 'p3');
    expect(v3.log.some((e) => e.text.includes('[2c]'))).toBe(true);
    expect(JSON.stringify(v3)).not.toContain('Qh');
  });
});

// ───────────────────────── 족보 변형 (게임) ─────────────────────────

describe('2차 족보 변형 (쇼다운)', () => {
  it('순혈: 홀카드 2장이 모두 쓰인 같은 족보 종류면 숫자와 상관없이 이긴다', () => {
    const s = setup(3, { augs: { p1: ['pureBlood'] }, deal: { board: cards('Ks 9d 7c 4h 2s'), hands: { p1: cards('3h 3d'), p2: cards('Kd Qc'), p3: cards('8c 6c') } } });
    toShowdown(s);
    expect(s.result!.won.p1).toBe(60);
    expect(view(s, 'p2').result!.entries.find((e) => e.id === 'p1')!.tiebreak).toEqual(['순혈']);
  });

  it('순혈: 상대도 조건을 만족하면 원래 비교', () => {
    const s = setup(3, { augs: { p1: ['pureBlood'], p2: ['pureBlood'] }, deal: { board: cards('Ks 9d 7c 4h 2s'), hands: { p1: cards('3h 3d'), p2: cards('Qd Qc'), p3: cards('8c 6c') } } });
    toShowdown(s);
    expect(s.result!.won.p2).toBe(60);
  });

  it('순혈 + 족보 역전: 역전 중에도 보유자가 이긴다', () => {
    const s = setup(3, { augs: { p1: ['pureBlood'], p3: ['flipTable'] }, deal: { board: cards('Ks 9d 7c 4h 2s'), hands: { p1: cards('Qh Qd'), p2: cards('3d 3c'), p3: cards('Ac Jc') } } });
    passUntil(s, () => s.phase === 'declare' && s.street === 'river');
    act(s, 'p3', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    toShowdown(s);
    // 역전: 원페어끼리는 낮은 33이 이기지만, p1 의 순혈이 우선 → p1, p3(하이카드)는 역전으로 가장 강함
    expect(s.result!.won.p3).toBe(60);
    const s2 = setup(2, { augs: { p1: ['pureBlood'], p2: ['flipTable'] }, deal: { board: cards('Ks 9d 7c 4h 2s'), hands: { p1: cards('Qh Qd'), p2: cards('3d 3c') } } });
    passUntil(s2, () => s2.phase === 'declare' && s2.street === 'river');
    if (getPending(s2).playerIds[0] === 'p2') act(s2, 'p2', { type: 'declare', augment: 'flipTable' });
    resolveAll(s2);
    toShowdown(s2);
    expect(s2.result!.won.p1).toBe(40);
  });

  it('블랙잭: 리버 선언 기회에 비공개 발동, 21이면 풀하우스 동급 (못 만들면 선택지에 없음)', () => {
    const s = setup(3, {
      augs: { p1: ['blackjack'], p3: ['blackjack'] },
      deal: { board: cards('5c 3d 2h 9s 8s'), hands: { p1: cards('Kd Ah'), p2: cards('Qs Qd'), p3: cards('Jc Th') } },
    });
    passUntil(s, () => s.phase === 'declare' && s.street === 'river');
    expect(getPending(s).playerIds).toEqual(['p1']); // p3 는 21을 만들 수 없음
    act(s, 'p1', { type: 'declare', augment: 'blackjack' });
    expect(view(s, 'p2').log.at(-1)!.text).toBe('P1님이 비공개 증강을 사용했습니다');
    resolveAll(s);
    toShowdown(s);
    expect(s.result!.won.p1).toBe(60);
    const e = view(s, 'p2').result!.entries.find((x) => x.id === 'p1')!;
    expect(e.variants).toEqual(['블랙잭(풀하우스 동급)']);
  });

  it('동맹 플러시·4장 스트레이트·보폭 두 배가 쇼다운 결과에 표시된다', () => {
    const s = setup(3, {
      augs: { p1: ['parity'], p2: ['fourStraight'], p3: ['doubleStep'] },
      deal: { board: cards('Qc 8d 4h 9s 3c'), hands: { p1: cards('2c 6c'), p2: cards('5c 2h'), p3: cards('6d Th') } },
      before: (st) => {
        st.players[0].augments[0].parity = 'even';
      },
    });
    toShowdown(s);
    const v = view(s, 'p1').result!;
    const names = Object.fromEntries(v.entries.map((e) => [e.id, e.variants]));
    expect(names.p1).toEqual(['동맹 플러시']);
    expect(names.p2).toEqual(['4장 스트레이트']);
    expect(names.p3).toEqual(['보폭 두 배 스트레이트']);
    expect(s.result!.won.p1).toBe(60);
  });

  it('동맹 플러시 + 족보 역전: 변형을 먼저 적용한 뒤 뒤집는다', () => {
    const s = setup(2, {
      augs: { p1: ['parity'], p2: ['flipTable'] },
      deal: { board: cards('Qc 8d 4h 9s 3c'), hands: { p1: cards('2c Td'), p2: cards('Kd 5h') } },
      before: (st) => {
        st.players[0].augments[0].parity = 'even';
      },
    });
    passUntil(s, () => s.phase === 'declare' && s.street === 'river');
    act(s, getPending(s).playerIds[0], { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    toShowdown(s);
    expect(s.result!.won.p2).toBe(40);
  });
});

// ───────────────────────── 경제/베팅형 ─────────────────────────

describe('2차 경제/베팅형', () => {
  it('모범납세자: 블라인드를 4번 내면 다음 블라인드 1번 면제 (아무도 내지 않음, 최소 베팅 BB 그대로)', () => {
    const s = setup(3, { augs: { p2: ['modelTaxpayer'] }, before: (st) => (st.players[1].blindsPaid = 4) });
    expect(P(s, 'p2').streetBet).toBe(0);
    expect(P(s, 'p2').blindsPaid).toBe(0);
    expect(s.currentBet).toBe(20);
    expect(view(s, 'p1').log.some((e) => e.text.includes('모범납세자'))).toBe(true);
    const s2 = setup(3, { augs: { p2: ['modelTaxpayer'] } });
    expect(P(s2, 'p2').streetBet).toBe(10);
    expect(P(s2, 'p2').blindsPaid).toBe(1);
  });

  it('세무서: 다른 사람이 공개형 증강을 선언하면 그 사람이 나에게 1BB', () => {
    const s = setup(3, { augs: { p1: ['glassTable'], p2: ['taxOffice'] } });
    use(s, 'p1', 'glassTable');
    expect(P(s, 'p1').chips).toBe(980);
    expect(P(s, 'p2').chips).toBe(1010);
  });

  it('서킷브레이커: 레이즈 3번 뒤 선언하면 라운드 칩을 돌려주고 첫 행동자부터, 레이즈 1회 제한, 사이드팟 정상', () => {
    const s = setup(3, { augs: { p1: ['circuitBreaker'] }, chips: [1000, 1000, 200], deal: { board: cards(BOARD), hands: { p1: cards('Qc Qd'), p2: cards('Jc Jd'), p3: cards('Ac Ah') } } });
    act(s, 'p1', { type: 'raise', amount: 60 });
    expect(tryUse(s, 'p1', 'circuitBreaker').ok).toBe(false);
    act(s, 'p2', { type: 'raise', amount: 120 });
    act(s, 'p3', { type: 'allin' });
    expect(toAct(s)).toBe('p1');
    use(s, 'p1', 'circuitBreaker');
    resolveAll(s);
    expect([P(s, 'p1').streetBet, P(s, 'p2').streetBet, P(s, 'p3').streetBet]).toEqual([0, 10, 20]);
    expect([P(s, 'p1').chips, P(s, 'p2').chips, P(s, 'p3').chips]).toEqual([1000, 990, 180]);
    expect(P(s, 'p3').allIn).toBe(false);
    expect(toAct(s)).toBe('p1');
    expect(view(s, 'p1').table.raiseCap).toBe(1);
    act(s, 'p1', { type: 'raise', amount: 300 });
    expect(applyAction(s, 'p2', { type: 'raise', amount: 600 }).ok).toBe(false);
    expect(legalActions(s, 'p2')!.raise).toBe(false);
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'call' }); // 올인 콜 200
    toShowdown(s);
    const pots = s.result!.pots;
    expect(pots.map((p) => p.amount)).toEqual([600, 200]);
    expect(s.result!.won.p3).toBe(600);
    expect(s.result!.won.p1).toBe(200);
  });

  it('내기할래?: 쇼다운에서 졌는데 우승 족보 예측이 맞으면 낸 칩의 50%를 팟에서 환급 (예측은 나만)', () => {
    const s = setup(3, { augs: { p1: ['bet'] }, deal: { board: cards(BOARD), hands: { p1: cards('9h 8h'), p2: cards('Ad 3c'), p3: cards('5c 6c') } } });
    use(s, 'p1', 'bet', { choice: 1 });
    resolveAll(s);
    expect(view(s, 'p1').you.extra.betPrediction).toBe(1);
    expect(JSON.stringify(view(s, 'p2'))).not.toContain('예측했습니다');
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 - 20 + 10);
    expect(s.result!.extras.some((x) => x.includes('내기할래?'))).toBe(true);
    expect(s.result!.won.p2).toBe(50);
  });

  it('내기할래?: 첫 행동 뒤에는 쓸 수 없고, 폴드하면 효과 없음', () => {
    const s = setup(3, { augs: { p2: ['bet'] } });
    act(s, 'p1', { type: 'call' });
    use(s, 'p2', 'bet', { choice: 0 });
    resolveAll(s);
    act(s, 'p2', { type: 'fold' });
    expect(tryUse(s, 'p2', 'bet', { choice: 1 }).ok).toBe(false);
  });

  it('왕귀: 쇼다운 패배 3번 뒤 첫 승리면 팟의 50%(최대 20BB)를 남은 플레이어가 나눠 낸다 (횟수는 나만)', () => {
    const s = setup(3, { augs: { p1: ['lateBloomer'] }, before: (st) => (st.players[0].lateLosses = 3), deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('9c Td'), p3: cards('6c 8d') } } });
    expect(view(s, 'p1').you.extra.lateLosses).toBe(3);
    expect(view(s, 'p2').you.extra.lateLosses).toBeNull();
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 - 20 + 60 + 30);
    expect(P(s, 'p2').chips).toBe(980 - 15);
    expect(P(s, 'p1').lateLosses).toBe(0);
  });

  it('왕귀: 쇼다운에서 팟을 못 받고 지면 횟수가 쌓인다', () => {
    const s = setup(3, { augs: { p1: ['lateBloomer'] }, deal: { board: cards(BOARD), hands: { p1: cards('9c Td'), p2: cards('Ac Ah'), p3: cards('6c 8d') } } });
    toShowdown(s);
    expect(P(s, 'p1').lateLosses).toBe(1);
  });

  it('불사의 토템: 쇼다운에서 올인으로 칩을 모두 잃으면 승자 몫에서 10BB를 남겨 받고 계속', () => {
    const s = setup(3, { augs: { p1: ['totem'] }, chips: [100, 1000, 1000], deal: { board: cards(BOARD), hands: { p1: cards('9c Td'), p2: cards('Ac Ah'), p3: cards('6c 8d') } } });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    toShowdown(s);
    expect(P(s, 'p1').out).toBe(false);
    expect(P(s, 'p1').chips).toBe(200);
    expect(P(s, 'p2').chips).toBe(1000 - 100 + 220 - 200);
    expect(P(s, 'p1').augments[0].usesLeft).toBe(0);
  });
});

// ───────────────────────── 심리전형 ─────────────────────────

describe('2차 심리전형', () => {
  it('쇼맨십: 쇼다운 없이 이긴 뒤 공개하면 마지막 폴드한 상대에게서 1BB, 하이카드면 2BB', () => {
    const s = setup(3, { augs: { p1: ['showmanship'] }, deal: { hands: { p1: cards('2c 7d') } } });
    act(s, 'p1', { type: 'raise', amount: 100 });
    act(s, 'p2', { type: 'fold' });
    act(s, 'p3', { type: 'fold' });
    expect(view(s, 'p1').you.extra.showChoose).toBe(true);
    act(s, 'p1', { type: 'show', reveal: true });
    expect(P(s, 'p3').chips).toBe(980 - 40);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.shownCards).toEqual(['2c', '7d']);
  });

  it('소문: 누가 썼는지 알리지 않고 익명 메시지만', () => {
    const s = setup(3, { augs: { p1: ['rumor'] } });
    const seq = s.logSeq;
    use(s, 'p1', 'rumor', { rumor: 'counterSpell' });
    const r = view(s, 'p2').reaction!;
    expect(r.declarerName).toBe('누군가');
    expect(r.declarerId).toBe('');
    expect(view(s, 'p2').log.filter((e) => e.seq > seq).every((e) => !e.text.includes('P1'))).toBe(true);
    resolveAll(s);
    expect(view(s, 'p2').log.at(-1)!.text).toBe('📢 소문: 이 테이블 누군가 「카운터 스펠」 증강을 가지고 있다');
    expect(P(s, 'p1').augments[0].usesLeft).toBe(1);
  });
});

// ───────────────────────── 방어/카운터형 ─────────────────────────

describe('2차 방어/카운터형', () => {
  it('철벽: 이번 핸드 동안 강제 집행·실명 다트·너 나가의 대상이 될 수 없다', () => {
    const s = setup(3, { augs: { p1: ['getOut', 'blindDart'], p2: ['ironWall'] } });
    use(s, 'p2', 'ironWall');
    resolveAll(s);
    expect(tryUse(s, 'p1', 'getOut', { targetId: 'p2' }).ok).toBe(false);
    expect(tryUse(s, 'p1', 'blindDart', { targetId: 'p2' }).ok).toBe(false);
    expect(view(s, 'p1').you.augments.find((a) => a.id === 'getOut')!.targets).toEqual(['p3']);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(1);
  });

  it('철벽: 강제 집행도 막는다', () => {
    const s = setup(2, { augs: { p1: ['enforcement'], p2: ['ironWall'] }, chips: [200, 1000], deal: { board: cards(BOARD) } });
    use(s, 'p2', 'ironWall');
    resolveAll(s);
    passUntil(s, () => s.street === 'river');
    if (toAct(s) === 'p2') act(s, 'p2', { type: 'check' });
    act(s, 'p1', { type: 'allin' });
    expect(tryUse(s, 'p1', 'enforcement', { targetId: 'p2' }).ok).toBe(false);
  });

  it('면역: 공개형 반응 대기 중 사용하면 나만 빠진다 (유리 테이블이면 내 카드만 비공개)', () => {
    const s = setup(3, { augs: { p1: ['glassTable'], p2: ['immunity'] } });
    use(s, 'p1', 'glassTable');
    expect(view(s, 'p2').reaction!.canImmune).toBe(true);
    act(s, 'p2', { type: 'immunity' });
    resolveAll(s);
    const v3 = view(s, 'p3');
    expect(v3.players.find((p) => p.id === 'p2')!.shownCards).toBeNull();
    expect(v3.players.find((p) => p.id === 'p1')!.shownCards).not.toBeNull();
  });

  it('면역: 러시안 룰렛 추첨 제외, 너 나가 무효, 죽음과 세금 면제', () => {
    const rr = setup(3, { augs: { p1: ['russianRoulette'], p2: ['immunity'] } });
    use(rr, 'p1', 'russianRoulette');
    act(rr, 'p2', { type: 'immunity' });
    resolveAll(rr);
    expect(P(rr, 'p2').folded).toBe(false);
    const go = setup(3, { augs: { p1: ['getOut'], p2: ['immunity'] } });
    use(go, 'p1', 'getOut', { targetId: 'p2' });
    act(go, 'p2', { type: 'immunity' });
    resolveAll(go);
    expect(P(go, 'p2').folded).toBe(false);
    const dt = setup(3, { augs: { p1: ['deathTax'], p2: ['immunity', 'blank', 'thermal'], p3: ['blank', 'thermal'] } });
    use(dt, 'p1', 'deathTax');
    act(dt, 'p2', { type: 'immunity' });
    resolveAll(dt);
    expect(view(dt, 'p2').you.tax).toBe(0);
    expect(view(dt, 'p3').you.tax).toBe(20);
  });

  it('면역: 판 전체 규칙을 바꾸는 공개형(밥상 뒤집기 등)에는 쓸 수 없다', () => {
    for (const id of ['bombPot', 'highCardDuel', 'underdog', 'flipTable', 'restart'] as AugmentId[]) expect(AUGMENTS[id].tableWide).toBe(true);
    const s = setup(3, { augs: { p1: ['highCardDuel'], p2: ['immunity'] } });
    use(s, 'p1', 'highCardDuel');
    expect(view(s, 'p2').reaction!.canImmune).toBe(false);
    expect(applyAction(s, 'p2', { type: 'immunity' }).ok).toBe(false);
  });

  it('방탄조끼: 너 나가의 강제 폴드를 막는다', () => {
    const s = setup(3, { augs: { p1: ['getOut'], p3: ['vest'] } });
    use(s, 'p1', 'getOut', { targetId: 'p3' });
    resolveAll(s);
    expect(P(s, 'p3').folded).toBe(false);
    expect(P(s, 'p3').augments[0].usesLeft).toBe(0);
  });

  it('자물쇠: 라운드 시작 시 선언하면 그 라운드 동안 모두 액티브·공개형 증강 불가 (카운터 스펠 포함), 다음 라운드 해제', () => {
    const s = setup(3, { augs: { p1: ['glassTable', 'mulligan'], p2: ['padlock'], p3: ['counterSpell'] } });
    use(s, 'p2', 'padlock');
    use(s, 'p1', 'glassTable'); // 자물쇠가 적용되기 전(반응 대기 중)에는 선언 가능
    applyTimeouts(s); // 자물쇠 적용 → 유리 테이블 반응 대기
    expect(s.round.locked).toBe(true);
    expect(view(s, 'p3').reaction!.canCounter).toBe(false);
    expect(applyAction(s, 'p3', { type: 'counter' }).ok).toBe(false);
    applyTimeouts(s);
    expect(tryUse(s, 'p1', 'mulligan', { cardIndex: 0 }).ok).toBe(false);
    act(s, 'p1', { type: 'call' });
    expect(tryUse(s, 'p2', 'padlock').ok).toBe(false);
    passUntil(s, () => s.street === 'flop');
    expect(s.round.locked).toBe(false);
  });
});

// ───────────────────────── 공개형 ─────────────────────────

describe('2차 공개형', () => {
  it('폭탄 팟: 다음 핸드는 전원 3BB, 프리플랍 없이 바로 플랍, 3BB 미만이면 있는 만큼 올인', () => {
    const s = setup(3, {
      augs: { p1: ['bombPot'] },
      chips: [1000, 1000, 40],
      before: (st) => use(st, 'p1', 'bombPot'),
    });
    expect(s.street).toBe('flop');
    expect(s.boardRevealed).toBe(3);
    expect(s.players.map((p) => p.contributed)).toEqual([60, 60, 40]);
    expect(P(s, 'p3').allIn).toBe(true);
    expect(s.phase).toBe('betting');
    expect(totalChips(s)).toBe(2040);
  });

  it('실명 다트: 대상의 뷰에는 보드와 보드로 계산되는 정보(족보·카운팅)가 전혀 없고, 쇼다운 때 공개', () => {
    const s = setup(3, {
      augs: { p1: ['blindDart'], p2: ['counting', 'foresight', 'colorForecast', 'radar', 'leaderboard'] },
      deal: { board: cards(BOARD), hands: { p1: cards('9c 9d'), p2: cards('Qc Jh'), p3: cards('3c 3d') } },
    });
    use(s, 'p1', 'blindDart', { targetId: 'p2' });
    resolveAll(s);
    passUntil(s, () => s.street === 'turn');
    const v = view(s, 'p2');
    const json = JSON.stringify(v);
    for (const c of cards(BOARD)) expect(json).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
    expect(v.board.every((c) => c === null)).toBe(true);
    expect(v.you.hand).toBeNull();
    expect(v.you.counting).toBeNull();
    expect(v.you.boardBlind).toBe(true);
    for (const id of ['foresight', 'colorForecast', 'radar', 'leaderboard'] as AugmentId[]) {
      expect(v.you.augments.find((a) => a.id === id)!.usableNow).toBe(false);
    }
    expect(view(s, 'p3').board.filter(Boolean)).toHaveLength(4);
    toShowdown(s);
    expect(view(s, 'p2').result!.board).toEqual(cards(BOARD));
  });

  it('너 나가: 3명 이상일 때 상대 1명을 강제 폴드 (낸 칩은 팟에, 카드는 폴드처럼 기록)', () => {
    const s = setup(3, { augs: { p1: ['getOut'] } });
    use(s, 'p1', 'getOut', { targetId: 'p3' });
    resolveAll(s);
    expect(P(s, 'p3').folded).toBe(true);
    expect(P(s, 'p3').contributed).toBe(20);
    expect(s.used.filter((u) => u.kind === 'fold')).toHaveLength(2);
    const two = setup(2, { augs: { p1: ['getOut'] } });
    expect(tryUse(two, 'p1', 'getOut', { targetId: 'p2' }).ok).toBe(false);
  });

  it('하이카드: 핸드를 무효화하고 홀카드 1장이 가장 높은 사람이 팟 (동점 분배, 와일드 미적용)', () => {
    const s = setup(3, { augs: { p1: ['highCardDuel'], p2: ['favoritism'] }, deal: { hands: { p1: cards('Ah 2c'), p2: cards('Kd 7c'), p3: cards('Qs Js') } } });
    use(s, 'p1', 'highCardDuel');
    resolveAll(s);
    expect(s.phase).toBe('handEnd');
    expect(s.result!.won.p1).toBe(30);
    const tie = setup(3, { augs: { p1: ['highCardDuel'] }, deal: { hands: { p1: cards('Ah 2c'), p2: cards('Ad 7c'), p3: cards('Qs Js') } } });
    use(tie, 'p1', 'highCardDuel');
    resolveAll(tie);
    expect(tie.result!.won).toEqual({ p1: 15, p2: 15 });
  });

  it('언더독: 카드 배분 전 선언, 3핸드 동안 역전 (남은 핸드 수 표시), 밥상 뒤집기와 겹치면 상쇄', () => {
    const s = setup(3, { augs: { p1: ['underdog'] }, before: (st) => use(st, 'p1', 'underdog') });
    expect(view(s, 'p2').table.inverted).toBe(true);
    expect(view(s, 'p2').table.underdogHands).toBe(3);
    toShowdown(s);
    ok(startNextHand(s));
    expect(view(s, 'p2').table.underdogHands).toBe(2);
    toShowdown(s);
    ok(startNextHand(s));
    toShowdown(s);
    ok(startNextHand(s));
    expect(view(s, 'p2').table.inverted).toBe(false);
    expect(view(s, 'p2').table.underdogHands).toBe(0);
  });

  it('언더독 + 밥상 뒤집기: 이중 역전 상쇄', () => {
    const s = setup(3, {
      augs: { p1: ['underdog'], p3: ['flipTable'] },
      deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('9c Td'), p3: cards('6c 8d') } },
      before: (st) => use(st, 'p1', 'underdog'),
    });
    passUntil(s, () => s.phase === 'declare' && s.street === 'river');
    act(s, 'p3', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    expect(view(s, 'p1').table.inverted).toBe(false);
    toShowdown(s);
    expect(s.result!.won.p1).toBe(60);
  });

  it('죽음과 세금 + 공포탄: 공포탄도 진짜와 똑같이 세금을 내고, 세금이 모자라면 쓸 수 없다', () => {
    const mk = () => setup(3, { augs: { p2: ['deathTax'], p1: ['blank', 'thermal'] } });
    const a = mk();
    use(a, 'p2', 'deathTax');
    resolveAll(a);
    use(a, 'p1', 'blank');
    const b = mk();
    use(b, 'p2', 'deathTax');
    resolveAll(b);
    use(b, 'p1', 'thermal', { targetId: 'p3' });
    expect(P(a, 'p1').chips).toBe(P(b, 'p1').chips);
    const strip = (s: GameState) => view(s, 'p3').log.slice(-2).map((e) => e.text);
    expect(strip(a)).toEqual(strip(b));
    // 세금이 모자라면 사용 불가 (버튼 비활성)
    const c = mk();
    use(c, 'p2', 'deathTax');
    resolveAll(c);
    P(c, 'p1').chips = 10;
    expect(tryUse(c, 'p1', 'blank').ok).toBe(false);
    expect(view(c, 'p1').you.augments.find((x) => x.id === 'blank')!.usableNow).toBe(false);
  });

  it('나 다시 돌아갈래: 블라인드를 뺀 베팅 반환, 선언자는 50%를 은행에, 새 덱으로 프리플랍부터 (핸드 수는 1번)', () => {
    const s = setup(3, { augs: { p2: ['restart'], p1: ['foresight'] }, deal: { board: cards(BOARD) } });
    act(s, 'p1', { type: 'raise', amount: 100 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'call' });
    expect(s.street).toBe('flop');
    use(s, 'p1', 'foresight');
    resolveAll(s);
    const oldCards = [...s.board.slice(0, 4), ...s.players.flatMap((p) => p.hole)];
    const hand = s.handNumber;
    const before = totalChips(s);
    use(s, 'p2', 'restart');
    resolveAll(s);
    expect(s.street).toBe('preflop');
    expect(s.boardRevealed).toBe(0);
    expect(s.handNumber).toBe(hand);
    expect([P(s, 'p1').contributed, P(s, 'p2').contributed, P(s, 'p3').contributed]).toEqual([0, 10, 20]);
    expect(P(s, 'p1').chips).toBe(1000);
    expect(P(s, 'p2').chips).toBe(900 + 90 - 45);
    expect(s.stats.bankPaid).toBe(45);
    expect(totalChips(s)).toBe(before - 45);
    expect(toAct(s)).toBe('p1');
    // 이전 카드 정보(예지로 본 카드 등)는 모든 뷰에서 사라진다
    for (const id of ['p1', 'p2', 'p3']) {
      const v = view(s, id);
      expect(v.you.notes).toEqual([]);
      const logText = v.log.filter((e) => e.hand === hand).map((e) => e.text).join('\n');
      for (const c of oldCards) if (!s.players.some((p) => p.hole.includes(c))) expect(logText).not.toContain(`[${c}]`);
    }
    // 다시 시작한 핸드에서는 누구도 쓸 수 없다 (횟수도 돌려주지 않음)
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
    expect(s.effects.restarted).toBe(true);
  });
});

// ───────────────────────── 전체 게임 ─────────────────────────

describe('2차 풀 포함 봇 게임', () => {
  it.each([2, 5, 8])('%i인: 2차 증강을 잔뜩 들고 우승자 결정까지 오류 없이, 칩 보존', (n) => {
    for (const seed of [11, 12]) {
      const rng = seededRng(seed * 101 + n);
      let given = false;
      const s = playGame(n, seed * 13 + n, { handsPerLevel: 3, debug: true, initialPick: false }, (st) => {
        if (given) return;
        given = true;
        const pool2 = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].pool === 2);
        for (const p of st.players) {
          const owned: AugmentId[] = [];
          for (let k = 0; k < 8; k++) {
            const id = pool2[rng.int(pool2.length)];
            if (!canHold(owned, id)) continue;
            owned.push(id);
            ok(debugGiveAugment(st, p.id, id));
          }
        }
      });
      expect(s.phase).toBe('gameOver');
      expect(s.players.filter((p) => !p.out)).toHaveLength(1);
      expect(totalChips(s)).toBe(expectedChips(s, n * 1000));
    }
  }, 300000);
});
