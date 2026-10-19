// 3차 풀 증강 39개와 새 시스템 테스트
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
  Category,
  turnSecondsFor,
  kickPlayer,
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


const CARD_RE = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?![A-Za-z0-9])/g;

// ───────────────────────── 1. 시야·시간 제어 ─────────────────────────

describe('1. 시야·시간 제어', () => {
  it('안경 없어서 잘 안보여: 선언자 외에는 보드 무늬가 숫자만, 다른 사람 금액은 대략값, 파생 정보 없음', () => {
    const s = setup(3, {
      augs: { p1: ['glasses'], p2: ['counting', 'leaderboard', 'colorForecast'] },
      deal: { board: cards(BOARD), hands: { p1: cards('9c 9d'), p2: cards('Qc Jh'), p3: cards('3c 3d') } },
    });
    use(s, 'p1', 'glasses');
    resolveAll(s);
    act(s, 'p1', { type: 'raise', amount: 47 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'call' });
    passUntil(s, () => s.street === 'turn');
    const v = view(s, 'p2');
    expect(v.masks).toEqual({ board: false, suits: true, amounts: true });
    expect(v.board).toEqual(['A?', 'K?', '7?', '4?']);
    // 보드 카드의 정확한 코드는 어디에도 없다 (내 홀카드는 정확히)
    const json = JSON.stringify(v);
    for (const c of cards(BOARD)) expect(json).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
    expect(v.you.hole).toEqual(['Qc', 'Jh']);
    // 다른 사람의 칩·베팅은 BB 단위 대략값, 내 칩은 정확히
    const p1 = v.players.find((p) => p.id === 'p1')!;
    expect(p1.approx).toBe(true);
    expect(p1.chips % 20).toBe(0);
    expect(p1.chips).not.toBe(P(s, 'p1').chips);
    expect(v.pot % 20).toBe(0);
    expect(v.you.chips).toBe(P(s, 'p2').chips);
    expect(v.log.filter((e) => e.hand === s.handNumber).some((e) => /\b47\b/.test(e.text))).toBe(false);
    // 파생 정보 없음, 무늬를 알려 주는 색채 예보는 정상
    expect(v.you.hand).toBeNull();
    expect(v.you.counting).toBeNull();
    expect(v.you.augments.find((a) => a.id === 'leaderboard')!.usableNow).toBe(false);
    if (toAct(s) === 'p2') expect(v.you.augments.find((a) => a.id === 'colorForecast')!.usableNow).toBe(true);
    // 선언자는 또렷하게
    const v1 = view(s, 'p1');
    expect(v1.masks.suits).toBe(false);
    expect(v1.board).toEqual(cards('As Kd 7c 4h'));
    // 쇼다운 결과는 모두 또렷하게
    toShowdown(s);
    expect(view(s, 'p2').result!.board).toEqual(cards(BOARD));
    expect(view(s, 'p2').masks.suits).toBe(false);
  });

  it('안경 없어서 잘 안보여 + 실명 다트: 보드 전체가 가려지고, 면역이면 또렷하게', () => {
    const s = setup(3, { augs: { p1: ['glasses', 'blindDart'], p3: ['immunity'] }, deal: { board: cards(BOARD) } });
    use(s, 'p1', 'glasses');
    act(s, 'p3', { type: 'immunity' });
    resolveAll(s);
    use(s, 'p1', 'blindDart', { targetId: 'p2' });
    resolveAll(s);
    passUntil(s, () => s.street === 'flop');
    const v2 = view(s, 'p2');
    expect(v2.masks).toEqual({ board: true, suits: true, amounts: true });
    expect(v2.board.every((c) => c === null)).toBe(true);
    const v3 = view(s, 'p3');
    expect(v3.masks.suits).toBe(false);
    expect(v3.board).toEqual(cards('As Kd 7c'));
  });

  it('메이드 인 헤븐: 다음 핸드부터 매 핸드 5초씩 감소 (최소 5초), 선언자 제외, 중복 합산, 레벨이 바뀌면 복구', () => {
    const s = setup(3, { augs: { p1: ['heaven'], p2: ['heaven'], p3: ['immunity'] } });
    use(s, 'p1', 'heaven');
    resolveAll(s);
    expect(turnSecondsFor(s, 'p2', 30)).toBe(30); // 선언한 핸드는 그대로
    toShowdown(s);
    ok(startNextHand(s));
    expect(turnSecondsFor(s, 'p2', 30)).toBe(25);
    expect(turnSecondsFor(s, 'p1', 30)).toBe(30);
    expect(view(s, 'p2').you.turnCut).toBe(5);
    use(s, 'p2', 'heaven');
    act(s, 'p3', { type: 'immunity' });
    resolveAll(s);
    toShowdown(s);
    ok(startNextHand(s));
    // p1 효과 2핸드째 10초 + p2 효과 1핸드째 5초 (p1 은 p2 효과만, p2 는 p1 효과만)
    expect(turnSecondsFor(s, 'p3', 30)).toBe(20); // p3 는 p2 효과에서 면역
    expect(turnSecondsFor(s, 'p1', 30)).toBe(25);
    expect(turnSecondsFor(s, 'p2', 30)).toBe(20);
    for (let i = 0; i < 6; i++) {
      toShowdown(s);
      ok(startNextHand(s));
    }
    expect(turnSecondsFor(s, 'p3', 30)).toBe(5);
    expect(turnSecondsFor(s, 'p3', 15)).toBe(5);
    // 블라인드 레벨이 바뀌면 원래 시간
    s.forceLevelUp = true;
    toShowdown(s);
    ok(startNextHand(s));
    for (let i = 0; i < 10 && s.phase === 'augmentSelect'; i++) applyTimeouts(s);
    expect(turnSecondsFor(s, 'p3', 30)).toBe(30);
    expect(s.heaven).toEqual([]);
  });

  it('메이드 인 헤븐 중 시간 초과 자동 폴드 횟수를 센다', () => {
    const s = setup(3, { augs: { p2: ['heaven'] } });
    use(s, 'p2', 'heaven');
    resolveAll(s);
    toShowdown(s);
    ok(startNextHand(s));
    expect(toAct(s)).toBe('p2');
    act(s, 'p2', { type: 'raise', amount: 100 });
    const id = toAct(s);
    expect(turnSecondsFor(s, id, 30)).toBe(25);
    applyTimeouts(s);
    expect(s.stats.heavenFolds).toBe(1);
  });
});

// ───────────────────────── 2. 보드·팟 구조 ─────────────────────────

/** 다음 선언 기회(declare)까지 진행 */
const toWindow = (s: GameState, stage: string) => passUntil(s, () => s.phase === 'declare' && s.windowStage === stage);

describe('2. 보드·팟 구조', () => {
  it('보드 7장 + 홀카드 중 최선 5장으로 판정한다', () => {
    const r = evaluatePlayerHand(cards('2c 3d'), cards('Ah Kh Qh Jh 9c 8d Th'), {});
    expect(r.value.name).toBe('로열 플러시');
  });

  it('나누어떨어지지 않는 칩은 딜러 왼쪽에 가장 가까운 승자에게 모두 간다', async () => {
    const { splitPot } = await import('../src/pots.js');
    expect([...splitPot(11, ['a', 'b', 'c'])]).toEqual([['a', 5], ['b', 3], ['c', 3]]);
  });

  it('플러스 원: 리버 직후 6번째 보드 카드를 공개하고 6장으로 판정', () => {
    const s = setup(3, { augs: { p1: ['plusOne'] }, deal: { board: cards('2h 5d 9c Jd Ks'), hands: { p1: cards('Qc 3s'), p2: cards('Kd 4c'), p3: cards('6c 7c') } }, before: (st) => ok(debugSetNextDeal(st, { board: cards('2h 5d 9c Jd Ks'), hands: { p1: cards('Qc 3s'), p2: cards('Kd 4c'), p3: cards('6c 7c') }, deck: ['Tc'] })) });
    toWindow(s, 'river');
    act(s, 'p1', { type: 'declare', augment: 'plusOne' });
    resolveAll(s);
    expect(s.boardRevealed).toBe(6);
    expect(s.board[5]).toBe('Tc');
    expect(view(s, 'p2').board).toHaveLength(6);
    toShowdown(s);
    // p1: 9-T-J-Q-K 스트레이트 (6번째 카드 Tc 사용)
    expect(s.result!.won.p1).toBe(60);
  });

  it('자본주의: 플랍·턴 라운드가 끝날 때 가장 크게 베팅한 사람이 보드를 1장 더 깔지 정한다 (최대 7장)', () => {
    const s = setup(3, { augs: { p2: ['capitalism'] } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p2', 'capitalism');
    resolveAll(s);
    act(s, 'p2', { type: 'raise', amount: 40 });
    act(s, 'p3', { type: 'call' });
    act(s, 'p1', { type: 'call' });
    expect(s.phase).toBe('declare');
    expect(getPending(s).playerIds).toEqual(['p2']);
    expect(view(s, 'p2').you.declare!.options.map((o) => o.id)).toEqual(['capitalism']);
    act(s, 'p2', { type: 'declare', augment: 'capitalism' });
    expect(s.board).toHaveLength(6);
    expect(s.street).toBe('turn');
    expect(s.boardRevealed).toBe(5); // 추가 1장 + 턴
    // 아무도 베팅하지 않은 라운드는 추가 없음
    passUntil(s, () => s.street === 'river');
    expect(s.board).toHaveLength(6);
    expect(s.boardRevealed).toBe(6);
  });

  it('거꾸로 강을 거슬러: 다음 핸드 보드가 1 → 1 → 3장 순서로 공개', () => {
    const s = setup(3, { augs: { p1: ['reverseRiver'] }, before: (st) => use(st, 'p1', 'reverseRiver') });
    expect(view(s, 'p2').table.revealPlan).toEqual([1, 2, 5]);
    passUntil(s, () => s.street === 'flop');
    expect(s.boardRevealed).toBe(1);
    passUntil(s, () => s.street === 'turn');
    expect(s.boardRevealed).toBe(2);
    passUntil(s, () => s.street === 'river');
    expect(s.boardRevealed).toBe(5);
  });

  it('더블 보드: 보드 2세트, 각 보드의 승자가 팟을 반씩', () => {
    const s = setup(3, {
      augs: { p1: ['doubleBoard'] },
      deal: { board: cards('Ah 2c 7d 9s Jc'), hands: { p1: cards('As Ad'), p2: cards('Ks 5c'), p3: cards('3c 4d') }, deck: cards('Kc Kd 3h 4s 8d') },
    });
    use(s, 'p1', 'doubleBoard');
    resolveAll(s);
    expect(s.board2).toEqual(cards('Kc Kd 3h 4s 8d'));
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    passUntil(s, () => s.street === 'flop');
    expect(view(s, 'p3').board2).toEqual(cards('Kc Kd 3h'));
    toShowdown(s);
    const pot = s.result!.pots[0];
    expect(pot.units!.map((u) => [u.label, u.winners, u.amount])).toEqual([
      ['첫 보드', ['p1'], 30],
      ['두 번째 보드', ['p2'], 30],
    ]);
  });

  it('두 번의 운명: 모두 올인이면 턴 직후 선언, 리버를 두 번 뽑아 팟을 반씩', () => {
    const s = setup(2, {
      augs: { p1: ['twoFates'] },
      chips: [500, 500],
      deal: { board: cards('Ah 2c 7d 9s Jc'), hands: { p1: cards('As 3d'), p2: cards('Ks Kd') }, deck: ['Kh'] },
    });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'call' });
    toWindow(s, 'turn');
    act(s, 'p1', { type: 'declare', augment: 'twoFates' });
    resolveAll(s);
    expect(s.board2!.slice(0, 4)).toEqual(s.board.slice(0, 4));
    expect(s.board2![4]).toBe('Kh');
    toShowdown(s);
    const u = s.result!.pots[0].units!;
    expect(u.map((x) => x.winners)).toEqual([['p1'], ['p2']]);
    expect(u.map((x) => x.amount)).toEqual([500, 500]);
  });

  it('미리 온 결말: 다음 핸드 리버를 미리 공개 예약, 되감기로 바꿀 수 없다', () => {
    const s = setup(3, { augs: { p1: ['prophecy'], p2: ['rewind'] }, before: (st) => use(st, 'p1', 'prophecy') });
    const res = view(s, 'p3').reserved;
    expect(res).toHaveLength(1);
    expect(res[0].index).toBe(4);
    expect(res[0].card).toBe(s.board[4]);
    toWindow(s, 'turn');
    // 턴에서는 되감기 가능, 리버(예약)에서는 불가
    act(s, getPending(s).playerIds[0], { type: 'declare', augment: null });
    passUntil(s, () => s.street === 'river');
    expect(s.board[4]).toBe(res[0].card);
    expect(view(s, 'p2').you.declare).toBeNull();
  });

  it('턴과 리버 사이: 두 카드를 나만 미리 보고 순서를 정한다 (확정 카드라 양자택일 불가)', () => {
    const s = setup(3, { augs: { p1: ['turnRiver', 'eitherOr'] }, deal: { board: cards(BOARD) } });
    toWindow(s, 'flop');
    expect(view(s, 'p1').you.declare!.options.map((o) => o.id).sort()).toEqual(['eitherOr', 'turnRiver']);
    act(s, 'p1', { type: 'declare', augment: 'turnRiver' });
    expect(view(s, 'p3').log.some((e) => e.text.includes('턴과 리버 사이'))).toBe(true);
    resolveAll(s);
    expect(view(s, 'p1').you.extra.turnRiver).toEqual({ cards: ['4h', '2s'], swap: null });
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/"4h"|"2s"|\[4h\]|\[2s\]/);
    act(s, 'p1', { type: 'turnRiver', swap: true });
    passUntil(s, () => s.street === 'river');
    expect(s.board.slice(3, 5)).toEqual(['2s', '4h']);
  });

  it('하이로우: 가장 높은 패와 가장 낮은 패가 팟을 반씩', () => {
    const s = setup(3, { augs: { p1: ['highLow'] }, deal: { board: cards('Ah 2c 7d 9s Jc'), hands: { p1: cards('As Ad'), p2: cards('3s 4d'), p3: cards('Kc Qd') } } });
    use(s, 'p1', 'highLow');
    resolveAll(s);
    toShowdown(s);
    const u = s.result!.pots[0].units!;
    expect(u.map((x) => [x.label, x.winners])).toEqual([['하이', ['p1']], ['로우', ['p2']]]);
  });

  it('동결: 핸드가 끝날 때 지정한 보드 카드가 다음 핸드 플랍에 반드시 포함된다 (모두에게 공개)', () => {
    const s = setup(3, { augs: { p1: ['freeze'] }, deal: { board: cards(BOARD) } });
    toShowdown(s);
    use(s, 'p1', 'freeze', { boardIndex: 1 });
    resolveAll(s);
    expect(view(s, 'p3').log.some((e) => e.text.includes('[Kd]'))).toBe(true);
    ok(startNextHand(s));
    expect(view(s, 'p2').reserved.map((r) => r.card)).toEqual(['Kd']);
    expect(s.board.slice(0, 3)).toContain('Kd');
  });

  it('자석: 턴·리버 중 지정한 무늬가 아닌 카드가 처음 나오면 버리고 다시 뽑는다 (한 번만)', () => {
    const s = setup(3, { augs: { p1: ['magnet'] }, deal: { board: cards('As Kd 7c 4h 2s'), deck: ['9d'] } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'magnet', { choice: 0 }); // 스페이드
    resolveAll(s);
    passUntil(s, () => s.street === 'turn');
    expect(s.board[3]).toBe('9d'); // 4h 버리고 다시 뽑은 카드는 무늬와 관계없이 확정
    passUntil(s, () => s.street === 'river');
    expect(s.board[4]).toBe('2s');
  });

  it('맞바꾸기: 턴 이후 홀카드 1장과 보드 카드 1장을 바꾸고 공개', () => {
    const s = setup(3, { augs: { p2: ['swapBoard'] }, deal: { board: cards(BOARD), hands: { p2: cards('Qc Jh') } } });
    passUntil(s, () => s.street === 'flop');
    expect(tryUse(s, 'p2', 'swapBoard', { cardIndex: 0, boardIndex: 0 }).ok).toBe(false);
    passUntil(s, () => s.street === 'turn');
    use(s, 'p2', 'swapBoard', { cardIndex: 0, boardIndex: 0 });
    resolveAll(s);
    expect(P(s, 'p2').hole).toEqual(['As', 'Jh']);
    expect(s.board[0]).toBe('Qc');
    expect(view(s, 'p3').log.some((e) => e.text.includes('[Qc]') && e.text.includes('[As]'))).toBe(true);
  });

  it('배수진: 폴드·레이즈 금지, 시간 초과면 콜, 면역이면 폴드 가능', () => {
    const s = setup(3, { augs: { p1: ['lastStand'], p3: ['immunity'] } });
    use(s, 'p1', 'lastStand');
    act(s, 'p3', { type: 'immunity' });
    resolveAll(s);
    expect(applyAction(s, 'p1', { type: 'fold' }).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'raise', amount: 40 }).ok).toBe(false);
    const l = legalActions(s, 'p1')!;
    expect([l.fold, l.raise, l.allIn]).toEqual([false, false, false]);
    applyTimeouts(s);
    expect(P(s, 'p1').streetBet).toBe(20);
    act(s, 'p2', { type: 'call' });
    expect(legalActions(s, 'p3')!.fold).toBe(true);
  });

  it('사이드 팟 브레이커: 내 올인으로 생긴 사이드팟의 30%를 메인 팟 승리 후 가져온다', () => {
    const s = setup(3, {
      augs: { p1: ['sidePotBreaker'] },
      chips: [100, 1000, 1000],
      deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('Kc Kh'), p3: cards('Qc Qd') } },
    });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'raise', amount: 300 });
    act(s, 'p3', { type: 'call' });
    toShowdown(s);
    expect(s.result!.pots.map((p) => p.amount)).toEqual([300, 400]);
    const p2Before = P(s, 'p2').chips;
    use(s, 'p1', 'sidePotBreaker');
    resolveAll(s);
    expect(P(s, 'p1').chips).toBe(300 + 120);
    expect(P(s, 'p2').chips).toBe(p2Before - 120);
  });

  it('무승부로 하지 않을래?: 같은 족보 종류로 졌으면 결과 직후 나에게만 선택 창, 발동하면 반씩', () => {
    const s = setup(3, { augs: { p2: ['drawOffer'] }, deal: { board: cards('As 9d 7c 4h 2s'), hands: { p1: cards('Kc Kh'), p2: cards('Qc Qh'), p3: cards('3c 5d') } } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    toShowdown(s);
    expect(view(s, 'p2').you.extra.drawPrompt).toEqual({ winnerName: 'P1' });
    expect(view(s, 'p1').you.extra.drawPrompt).toBeNull();
    expect(getPending(s).playerIds).toEqual(['p2']);
    act(s, 'p2', { type: 'draw', accept: true });
    expect(P(s, 'p1').chips).toBe(980 + 30);
    expect(P(s, 'p2').chips).toBe(980 + 30);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(2);
  });

  it('무승부로 하지 않을래?: 승자가 동점 처리 증강을 가졌으면 상쇄되어 발동할 수 없다, 응답이 없으면 발동 안 함', () => {
    const s = setup(3, { augs: { p2: ['drawOffer'], p1: ['kickerMaster'] }, deal: { board: cards('As 9d 7c 4h 2s'), hands: { p1: cards('Kc Kh'), p2: cards('Qc Qh'), p3: cards('8c 6d') } } });
    toShowdown(s);
    expect(view(s, 'p2').you.extra.drawPrompt).toBeNull();
    const t = setup(3, { augs: { p2: ['drawOffer'] }, chips: [1000, 20, 1000], deal: { board: cards('As 9d 7c 4h 2s'), hands: { p1: cards('Kc Kh'), p2: cards('Qc Qh'), p3: cards('8c 6d') } } });
    toShowdown(t);
    expect(view(t, 'p2').you.extra.drawPrompt).not.toBeNull();
    // 탈락 판정은 선택이 끝날 때까지 미룬다
    expect(P(t, 'p2').out).toBe(false);
    ok(startNextHand(t));
    expect(P(t, 'p2').out).toBe(true);
  });
});

// ───────────────────────── 3. 제안·응답 ─────────────────────────

const respond = (s: GameState, id: string, a: Record<string, unknown>) => act(s, id, { type: 'respond', ...a } as GameAction);

describe('3. 제안·응답', () => {
  const HANDS = { p1: cards('9c 9d'), p2: cards('Kc Qh'), p3: cards('3c 5d') };

  it('골라 봐: 수락하면 3BB를 내고 고른 카드를 그 상대만 본다, 제안 중에는 다른 행동·증강이 멈춘다', () => {
    const s = setup(3, { augs: { p2: ['pickMe', 'heaven'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    expect(toAct(s)).toBe('p2');
    expect(tryUse(s, 'p2', 'pickMe', { targetId: 'p3', cardIndex: 0 }).ok).toBe(true);
    resolveAll(s);
    expect(s.phase).toBe('respond');
    expect(getPending(s)).toMatchObject({ kind: 'respond', playerIds: ['p3'] });
    // 제안 내용: 선언자는 보여 줄 카드, 대상은 가격만, 다른 사람은 아무것도
    expect(view(s, 'p2').respond!.card).toBe('Kc');
    expect(view(s, 'p3').respond).toMatchObject({ needMe: true, input: 'accept', card: null });
    expect(JSON.stringify(view(s, 'p3'))).not.toMatch(/"Kc"|\[Kc\]/);
    expect(JSON.stringify(view(s, 'p1'))).not.toMatch(/"Kc"|\[Kc\]/);
    expect(view(s, 'p1').respond!.needMe).toBe(false);
    // 응답 대기 중에는 베팅·증강 사용 불가
    expect(applyAction(s, 'p2', { type: 'check' }).ok).toBe(false);
    expect(tryUse(s, 'p2', 'heaven').ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'respond', accept: true }).ok).toBe(false);
    respond(s, 'p3', { accept: true });
    expect(P(s, 'p3').chips).toBe(980 - 60);
    expect(P(s, 'p2').chips).toBe(980 + 60);
    expect(lastNote(s, 'p3')).toContain('[Kc]');
    expect(s.phase).toBe('betting');
    expect(toAct(s)).toBe('p2');
  });

  it('골라 봐: 응답이 없으면(시간 초과) 거절', () => {
    const s = setup(3, { augs: { p2: ['pickMe'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p2', 'pickMe', { targetId: 'p3', cardIndex: 1 });
    resolveAll(s);
    applyTimeouts(s);
    expect(s.phase).toBe('betting');
    expect(P(s, 'p3').chips).toBe(980);
    expect(view(s, 'p1').log.some((e) => e.text.includes('거절'))).toBe(true);
  });

  it('공동 환승: 수락하면 두 사람이 동시에 1장씩 골라 맞바꾸고, 바꾼 카드는 두 사람에게만', () => {
    const s = setup(3, { augs: { p1: ['jointTransfer'] }, deal: { board: cards(BOARD), hands: HANDS } });
    toWindow(s, 'flop');
    expect(view(s, 'p1').you.declare!.targets.jointTransfer!.sort()).toEqual(['p2', 'p3']);
    act(s, 'p1', { type: 'declare', augment: 'jointTransfer', targetId: 'p2' });
    resolveAll(s);
    respond(s, 'p2', { accept: true });
    expect(getPending(s).playerIds.sort()).toEqual(['p1', 'p2']);
    expect(view(s, 'p2').respond!.input).toBe('card');
    respond(s, 'p1', { cardIndex: 0 });
    // 상대가 고르기 전에는 아무것도 바뀌지 않는다
    expect(P(s, 'p1').hole).toEqual(['9c', '9d']);
    respond(s, 'p2', { cardIndex: 1 });
    expect(P(s, 'p1').hole).toEqual(['Qh', '9d']);
    expect(P(s, 'p2').hole).toEqual(['Kc', '9c']);
    expect(JSON.stringify(view(s, 'p3'))).not.toMatch(/\[9c\]|\[Qh\]/);
    expect(s.phase).toBe('betting');
  });

  it('사채업자: 수락하면 5BB를 빌려주고 2핸드 뒤 7BB를 자동으로 받는다, 추방되면 사라진다', () => {
    const s = setup(3, { augs: { p1: ['loanShark'] } });
    use(s, 'p1', 'loanShark', { targetId: 'p2' });
    resolveAll(s);
    respond(s, 'p2', { accept: true });
    expect(P(s, 'p1').chips).toBe(1000 - 100);
    expect(P(s, 'p2').chips).toBe(990 + 100);
    expect(s.tasks).toEqual([{ kind: 'sharkRepay', playerId: 'p2', otherId: 'p1', dueHand: 3, amount: 140 }]);
    toShowdown(s);
    ok(startNextHand(s));
    expect(s.tasks).toHaveLength(1);
    toShowdown(s);
    const before = { p1: P(s, 'p1').chips, p2: P(s, 'p2').chips };
    ok(startNextHand(s));
    expect(s.tasks).toHaveLength(0);
    expect(P(s, 'p1').chips + P(s, 'p1').contributed).toBe(before.p1 + 140);
    expect(P(s, 'p2').chips + P(s, 'p2').contributed).toBe(before.p2 - 140);

    const t = setup(3, { augs: { p1: ['loanShark'] } });
    use(t, 'p1', 'loanShark', { targetId: 'p2' });
    resolveAll(t);
    respond(t, 'p2', { accept: true });
    ok(kickPlayer(t, 'p2'));
    expect(t.tasks).toHaveLength(0);
  });

  it('정보 경매: 비공개 입찰, 최고 입찰자만 턴 카드를 보고 낙찰금은 팟으로', () => {
    const s = setup(3, { augs: { p2: ['infoAuction'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p2', 'infoAuction');
    resolveAll(s);
    expect(getPending(s).playerIds.sort()).toEqual(['p1', 'p2', 'p3']);
    expect(applyAction(s, 'p1', { type: 'respond', bid: 10 }).ok).toBe(false); // 최소 1BB
    respond(s, 'p1', { bid: 40 });
    respond(s, 'p3', { bid: 0 });
    // 다른 사람의 입찰가는 보이지 않는다
    expect(view(s, 'p3').respond!.myAnswer).toEqual({ accept: null, bid: 0, choice: null, cardIndex: null });
    expect(JSON.stringify(view(s, 'p3').respond)).not.toContain('40');
    respond(s, 'p2', { bid: 60 });
    expect(P(s, 'p2').chips).toBe(980 - 60);
    expect(s.deadMoney).toBe(60);
    expect(lastNote(s, 'p2')).toContain('[4h]');
    expect(JSON.stringify(view(s, 'p1'))).not.toMatch(/\[4h\]|"4h"/);
    expect(view(s, 'p1').log.some((e) => e.text.includes('P2이(가) 60칩에 낙찰'))).toBe(true);
    passUntil(s, () => s.street === 'turn');
    expect(s.board[3]).toBe('4h');
  });

  it('카드 경매: 덱에서 공개한 카드를 낙찰자가 홀카드와 바꾼다 (버린 카드는 비공개), 실명 다트 대상은 볼 수 없다', () => {
    const s = setup(3, { augs: { p2: ['cardAuction'], p3: ['blindDart'] }, deal: { board: cards(BOARD), hands: HANDS, deck: ['Ah'] } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    use(s, 'p3', 'blindDart', { targetId: 'p1' });
    resolveAll(s);
    passUntil(s, () => s.street === 'flop');
    use(s, 'p2', 'cardAuction');
    resolveAll(s);
    expect(view(s, 'p3').auctionCard).toBe('Ah');
    expect(view(s, 'p1').auctionCard).toBeNull();
    expect(JSON.stringify(view(s, 'p1'))).not.toMatch(/\[Ah\]|"Ah"/);
    expect(getPending(s).playerIds.sort()).toEqual(['p2', 'p3']);
    respond(s, 'p3', { bid: 40, cardIndex: 1 });
    respond(s, 'p2', { bid: 20 });
    expect(P(s, 'p3').hole).toEqual(['3c', 'Ah']);
    expect(s.deadMoney).toBe(40);
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/\[5d\]|"5d"/);
  });

  it('진실 게임: 리버에서 공개 선언, 쇼다운에서 진실이면 콜한 상대 각각에게 3BB', () => {
    const s = setup(3, { augs: { p2: ['truthGame'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'river');
    use(s, 'p2', 'truthGame', { choice: 1 });
    resolveAll(s);
    expect(view(s, 'p3').table.notes).toContain('진실 게임: P2 "원페어 이상"');
    toShowdown(s);
    // p2 원페어(K) → 진실: p1, p3 각각 60 (팟은 휠 스트레이트인 p3)
    expect(s.result!.extras.some((x) => x.includes('진실'))).toBe(true);
    expect(P(s, 'p2').chips).toBe(980 + 120);
    expect(P(s, 'p1').chips).toBe(980 - 60);
  });

  it('눈싸움: 둘이 동시에 비공개 선언, 쇼다운에서 공개하고 한 명만 정직하면 2BB', () => {
    const s = setup(3, { augs: { p2: ['staredown'] }, deal: { board: cards(BOARD), hands: { ...HANDS, p3: cards('3c 8d') } } });
    passUntil(s, () => s.street === 'river');
    use(s, 'p2', 'staredown', { targetId: 'p3' });
    resolveAll(s);
    expect(getPending(s).playerIds.sort()).toEqual(['p2', 'p3']);
    respond(s, 'p3', { choice: 1 });
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/"choice":1/);
    respond(s, 'p2', { choice: 1 });
    expect(view(s, 'p1').log.some((e) => e.text.includes('"강함"'))).toBe(false);
    const p3Before = P(s, 'p3').chips;
    toShowdown(s);
    expect(s.result!.extras.find((x) => x.startsWith('눈싸움 공개'))).toContain('P2만 정직');
    expect(P(s, 'p3').chips).toBe(p3Before - 40);
  });

  it('밀봉 계약: 비공개 예측, 핸드가 끝나면 공개하고 맞히면 은행에서 3BB', () => {
    const s = setup(3, { augs: { p2: ['sealedContract'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'river');
    use(s, 'p2', 'sealedContract', { choice: 0 });
    resolveAll(s);
    expect(view(s, 'p2').you.extra.contract).toBe(0);
    expect(JSON.stringify(view(s, 'p1').log)).not.toContain('전원 폴드');
    expect(view(s, 'p1').table.notes).toContain('밀봉 계약: P2');
    act(s, 'p2', { type: 'raise', amount: 100 });
    act(s, 'p3', { type: 'fold' });
    act(s, 'p1', { type: 'fold' });
    expect(s.result!.extras.some((x) => x.includes('적중'))).toBe(true);
    expect(P(s, 'p2').chips).toBe(980 + 60 + 60);
    expect(s.stats.bankChips).toBe(60);
  });

  it('명추리: 맞히면 쇼다운 없이 팟을 가져가고, 틀리면 폴드하고 2BB, 이미 아는 카드는 실패', () => {
    const s = setup(3, { augs: { p3: ['nameIt'] }, deal: { board: cards(BOARD), hands: HANDS } });
    toWindow(s, 'preShowdown');
    expect(view(s, 'p3').you.declare!.targets.nameIt!.sort()).toEqual(['p1', 'p2']);
    act(s, getPending(s).playerIds[0], { type: 'declare', augment: 'nameIt', targetId: 'p1', card: '9d' });
    // 반응 대기 중에도 부른 카드는 다른 사람에게 보이지 않는다
    expect(JSON.stringify(view(s, 'p1').log.slice(-3))).not.toContain('9d');
    resolveAll(s);
    expect(s.phase).toBe('handEnd');
    expect(s.result!.showdown).toBe(false);
    expect(s.result!.won).toEqual({ p3: 60 });

    const t = setup(3, { augs: { p3: ['nameIt'] }, deal: { board: cards(BOARD), hands: HANDS } });
    toWindow(t, 'preShowdown');
    act(t, 'p3', { type: 'declare', augment: 'nameIt', targetId: 'p1', card: 'As' }); // 보드 카드 = 이미 아는 카드
    resolveAll(t);
    expect(P(t, 'p3').folded).toBe(true);
    expect(P(t, 'p1').chips).toBe(980 + 40);
    expect(t.phase).toBe('handEnd');
    expect(t.result!.entries.map((e) => e.id).sort()).toEqual(['p1', 'p2']);
  });
});

// ───────────────────────── 4. 좌석·증강 흐름 ─────────────────────────

describe('4. 좌석·증강 흐름', () => {
  it('3일 안에 오리라: 탈락하면 부활 대기, 3핸드 뒤 원래 자리로 10BB (남은 사람이 나눠 냄), 대기 중에는 관전자 뷰', () => {
    expect(canHold(['totem'], 'comeBack')).toBe(false);
    const s = setup(3, { augs: { p2: ['comeBack'] }, chips: [1000, 100, 1000], deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('9c 8d'), p3: cards('Qc Jd') } } });
    act(s, 'p1', { type: 'raise', amount: 200 });
    act(s, 'p2', { type: 'allin' });
    act(s, 'p3', { type: 'fold' });
    toShowdown(s);
    const p2 = P(s, 'p2');
    expect(p2.out).toBe(true);
    expect(p2.dormant).toBe(5);
    expect(p2.place).toBeNull();
    expect(view(s, 'p1').players.find((p) => p.id === 'p2')!.dormant).toBe(4);
    const v2 = view(s, 'p2');
    expect(v2.you.seated).toBe(false);
    expect(v2.you.hole).toEqual([]);
    for (let h = 2; h <= 4; h++) {
      ok(startNextHand(s));
      expect(P(s, 'p2').inHand).toBe(false);
      toShowdown(s);
    }
    const before = { p1: P(s, 'p1').chips, p3: P(s, 'p3').chips };
    ok(startNextHand(s));
    expect(s.handNumber).toBe(5);
    expect(P(s, 'p2').out).toBe(false);
    expect(P(s, 'p2').inHand).toBe(true);
    expect(P(s, 'p2').chips + P(s, 'p2').contributed).toBe(200);
    expect(P(s, 'p1').chips + P(s, 'p1').contributed).toBe(before.p1 - 100);
    expect(P(s, 'p3').chips + P(s, 'p3').contributed).toBe(before.p3 - 100);
  });

  it('3일 안에 오리라: 부활 대기 중 추방되면 부활이 취소된다, 남은 사람이 1명이면 대기자는 2위', () => {
    const s = setup(3, { augs: { p2: ['comeBack'] } });
    P(s, 'p2').chips = 0;
    toShowdown(s);
    ok(startNextHand(s));
    expect(P(s, 'p2').dormant).not.toBeNull();
    ok(kickPlayer(s, 'p2'));
    expect(s.tasks.some((t) => t.kind === 'revive')).toBe(false);
    const t = setup(2, { augs: { p2: ['comeBack'] }, chips: [1000, 20], deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('9c 8d') } } });
    toShowdown(t);
    expect(P(t, 'p2').chips).toBe(0);
    expect(t.phase).toBe('gameOver');
    expect(P(t, 'p2').place).toBe(2);
  });

  it('폭주기관차: 5BB 이상 팟을 연속으로 이기면 연승, 3연승이면 다음 선택에서 2개, 보상 뒤 처음부터', () => {
    const s = setup(3, { augs: { p1: ['runaway'] }, deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('Qc Jd'), p3: cards('8c 6d') } } });
    act(s, 'p1', { type: 'raise', amount: 60 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'call' });
    toShowdown(s);
    expect(P(s, 'p1').streak).toBe(1);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.streak).toBe(1);
    P(s, 'p1').streak = 3;
    s.forceLevelUp = true;
    ok(startNextHand(s));
    expect(s.phase).toBe('augmentSelect');
    const p1 = P(s, 'p1');
    expect(p1.pickExtra).toBe(1);
    expect(p1.streak).toBe(0);
    expect(view(s, 'p1').you.pickExtra).toBe(1);
    const first = p1.pickOptions![0];
    act(s, 'p1', { type: 'pick', augment: first });
    expect(p1.pickOptions).not.toBeNull();
    expect(p1.pickOptions).not.toContain(first);
    // 시간 초과면 남은 선택도 모두 자동으로
    applyTimeouts(s);
    expect(p1.augments.length).toBe(3);
    expect(s.phase).toBe('betting');
  });

  it('증강 셔플: 전원이 무작위 1개를 왼쪽 사람에게 (남은 횟수 그대로, 받은 사람만 앎), 면역이면 빠진다, 유일 증강', () => {
    const s = setup(3, {
      augs: { p1: ['augShuffle'], p2: ['thermal'], p3: ['immunity', 'observer'] },
      before: (st) => {
        st.players[1].augments[0].usesLeft = 2;
        use(st, 'p1', 'augShuffle');
        act(st, 'p3', { type: 'immunity' });
      },
    });
    // p3 는 면역으로 빠지고 p1 ↔ p2 만 주고받는다
    expect(P(s, 'p1').augments.map((a) => a.id)).toEqual(['thermal']);
    expect(P(s, 'p1').augments[0].usesLeft).toBe(2);
    expect(P(s, 'p2').augments.map((a) => a.id)).toEqual(['augShuffle']);
    expect(P(s, 'p3').augments.map((a) => a.id).sort()).toEqual(['immunity', 'observer']);
    expect(P(s, 'p1').augments[0].revealed).toBe(false);
    expect(JSON.stringify(view(s, 'p3').log)).not.toContain('열화상');
    expect(view(s, 'p1').you.notes.some((n) => n.text.includes('열화상 카메라'))).toBe(true);
    // 유일 증강: 다른 사람이 가진 동안 선택지에 나오지 않는다
    for (let i = 0; i < 30; i++) expect(rollAugmentOffer(5, [], seededRng(i), 2, ['augShuffle'])).not.toContain('augShuffle');
  });

  it('잠복: 다른 증강 1개를 숨기고 좌석 보유 수·탐문에서 빠지며, 처음 쓰면 드러난다', () => {
    const s = setup(3, {
      augs: { p1: ['thermal', 'lurk'], p2: ['inquiry'] },
      deal: { hands: { p1: cards('Ac Ah'), p2: cards('Qc Jd'), p3: cards('8c 6d') } },
    });
    expect(P(s, 'p1').augments.find((a) => a.id === 'thermal')!.hidden).toBe(true);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.augmentCount).toBe(1);
    expect(view(s, 'p1').players.find((p) => p.id === 'p1')!.augmentCount).toBe(2);
    use(s, 'p2', 'inquiry', { targetId: 'p1' });
    resolveAll(s);
    expect(lastNote(s, 'p2')).toBe('탐문: P1의 증강 별 개수 — ★');
    act(s, 'p1', { type: 'call' });
    use(s, 'p1', 'thermal', { targetId: 'p3' });
    resolveAll(s);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.augmentCount).toBe(2);

    // 숨길 증강이 없으면 다음에 얻는 증강
    const t = setup(3, { augs: { p1: ['lurk', 'thermal'] } });
    expect(P(t, 'p1').augments.find((a) => a.id === 'thermal')!.hidden).toBe(true);
    // 다음 핸드 시작 전까지 고를 수 있다
    const u = createGame(makePlayers(3).map((p) => ({ ...p, isBot: false })), { rng: seededRng(3), debug: true, initialPick: false, handsPerLevel: 1000 });
    ok(debugGiveAugment(u, 'p1', 'thermal'));
    ok(debugGiveAugment(u, 'p1', 'observer'));
    ok(debugGiveAugment(u, 'p1', 'lurk'));
    act(u, 'p1', { type: 'lurk', augment: 'observer' });
    expect(u.players[0].augments.filter((a) => a.hidden).map((a) => a.id)).toEqual(['observer']);
    ok(startNextHand(u));
    expect(applyAction(u, 'p1', { type: 'lurk', augment: 'thermal' }).ok).toBe(false);
  });

  it('사냥꾼: 내가 이긴 팟에서 다른 사람이 탈락하면 다 쓴 ★·★★ 액티브 증강 1개를 1회 충전', () => {
    const s = setup(3, {
      augs: { p1: ['hunter', 'thermal'] },
      chips: [1000, 1000, 100],
      deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('Qc Jd'), p3: cards('8c 6d') } },
      before: (st) => (st.players[0].augments[1].usesLeft = 0),
    });
    act(s, 'p1', { type: 'raise', amount: 100 });
    act(s, 'p2', { type: 'fold' });
    act(s, 'p3', { type: 'call' });
    toShowdown(s);
    expect(s.result!.busted).toEqual(['p3']);
    expect(findThermal(s).usesLeft).toBe(1);
  });

  it('대출: 은행에서 20BB, 5핸드 뒤 25BB 자동 상환, 모자라면 있는 만큼 내고 증강 1개 몰수', () => {
    const s = setup(3, { augs: { p1: ['loan', 'observer'] } });
    use(s, 'p1', 'loan');
    resolveAll(s);
    expect(P(s, 'p1').chips).toBe(1000 + 400);
    expect(s.tasks).toEqual([{ kind: 'loanRepay', playerId: 'p1', dueHand: 6, amount: 500 }]);
    s.tasks[0].dueHand = 2;
    toShowdown(s);
    P(s, 'p1').chips = 300;
    ok(startNextHand(s));
    expect(s.stats.bankChips).toBe(400);
    expect(s.stats.bankPaid).toBe(300);
    expect(P(s, 'p1').augments).toHaveLength(1);
    expect(s.tasks).toHaveLength(0);
  });
});

function findThermal(s: GameState) {
  return P(s, 'p1').augments.find((a) => a.id === 'thermal')!;
}

// ───────────────────────── 5. 판정 공유·팀·탈취 ─────────────────────────

describe('5. 판정 공유·팀·탈취', () => {
  const HANDS3 = { p1: cards('9c 8d'), p2: cards('Kc 3h'), p3: cards('6c 5d') };

  it('서로 다른 사람의 동점 처리 증강이 같은 비교에서 맞붙으면 상쇄되어 원래 비교', async () => {
    const { compareContenders } = await import('../src/showdown.js');
    const board = cards('2c 7d 9h Jc Ks');
    const base = { bestCards: [], kickerMaster: false, absoluteKicker: false, pureBlood: false };
    const a = { ...base, id: 'a', score: [1, 9, 13, 11, 7], pureBlood: true };
    const b = { ...base, id: 'b', score: [1, 13, 11, 9, 7], kickerMaster: true };
    expect(compareContenders(a, b, { inverted: false, board }).result).toBeLessThan(0);
    // 한쪽만이면 순혈이 이긴다
    expect(compareContenders(a, { ...b, kickerMaster: false }, { inverted: false, board }).result).toBeGreaterThan(0);
  });

  it('운명 공동체: 짝과 무작위 팀, 팀원이 이기면 팀원(쇼다운 참가)과 반씩 (낸 칩 한도), 면역이면 혼자', () => {
    const s = setup(4, {
      augs: { p1: ['destinyTeam'] },
      deal: { board: cards(BOARD), hands: { p1: cards('Ac Ah'), p2: cards('Qc Jd'), p3: cards('8c 6d'), p4: cards('9c 9d') } },
      before: (st) => use(st, 'p1', 'destinyTeam', { targetId: 'p3' }),
    });
    expect(s.teams).toContainEqual(['p1', 'p3']);
    expect(s.teams).toContainEqual(expect.arrayContaining(['p2', 'p4']));
    expect(view(s, 'p2').players.find((p) => p.id === 'p3')!.team).toBe(view(s, 'p2').players.find((p) => p.id === 'p1')!.team);
    // 팀원끼리도 홀카드는 보이지 않는다
    expect(JSON.stringify(view(s, 'p3'))).not.toMatch(/"Ac"|"Ah"/);
    toShowdown(s);
    // 팟 80: p1 승리, p3 는 낸 20 한도까지 받는다
    expect(s.result!.won).toEqual({ p1: 60, p3: 20 });

    const t = setup(4, {
      augs: { p1: ['destinyTeam'], p3: ['immunity'] },
      before: (st) => {
        use(st, 'p1', 'destinyTeam', { targetId: 'p3' });
        act(st, 'p3', { type: 'immunity' });
      },
    });
    expect(t.teams.flat()).not.toContain('p3');
    expect(t.teams).toHaveLength(1);
    expect(t.teams[0]).toContain('p1');
  });

  it('기생: 쇼다운 직전 지목한 상대의 높은 홀카드 1장으로도 족보를 만든다 (카드는 그대로)', () => {
    const s = setup(3, { augs: { p1: ['parasite'] }, deal: { board: cards(BOARD), hands: HANDS3 } });
    toWindow(s, 'preShowdown');
    act(s, getPending(s).playerIds[0], { type: 'declare', augment: 'parasite', targetId: 'p2' });
    resolveAll(s);
    toShowdown(s);
    // p1: 9c + p2 의 Kc → K 원페어(A·9·7 키커)로 p2 의 K 원페어(A·7·4)를 이긴다
    expect(s.result!.won).toEqual({ p1: 60 });
    expect(P(s, 'p2').hole).toEqual(['Kc', '3h']);
  });

  it('승격: 리버 직후 선언하면 족보를 한 단계 올려 판정 (최대 풀하우스)', () => {
    const s = setup(3, { augs: { p1: ['promotion'] }, deal: { board: cards(BOARD), hands: { p1: cards('9c 8d'), p2: cards('Qc Jh'), p3: cards('6c 5d') } } });
    toWindow(s, 'river');
    act(s, 'p1', { type: 'declare', augment: 'promotion' });
    resolveAll(s);
    toShowdown(s);
    expect(s.result!.won).toEqual({ p1: 60 });
    expect(s.result!.entries.find((e) => e.id === 'p1')!.handName).toContain('승격');
  });

  it('연금술: 홀카드 1장 숫자를 한 단계 올리거나 내리고 공개, 공개된 카드와 같아지면 불가', () => {
    const s = setup(3, { augs: { p1: ['alchemy'] }, deal: { board: cards(BOARD), hands: { p1: cards('9c 8d'), p2: cards('Qc Jh'), p3: cards('6c Qd') } } });
    toWindow(s, 'river');
    expect(applyAction(s, 'p1', { type: 'declare', augment: 'alchemy', cardIndex: 0, choice: 0 }).ok).toBe(true);
    resolveAll(s);
    expect(P(s, 'p1').alchemy).toEqual({ index: 0, from: '9c', to: '8c' });
    expect(view(s, 'p2').log.some((e) => e.text.includes('[9c]') && e.text.includes('[8c]'))).toBe(true);
    toShowdown(s);
    expect(s.result!.won).toEqual({ p1: 60 }); // 8 원페어
    const t = setup(3, { augs: { p1: ['alchemy'] }, deal: { board: cards(BOARD), hands: { p1: cards('Qs 3d'), p2: cards('Qc Jh'), p3: cards('6c Qd') } } });
    toWindow(t, 'river');
    // Qs → Ks 는 가능, Ks → As 는 보드 카드와 같아져 불가
    expect(applyAction(t, 'p1', { type: 'declare', augment: 'alchemy', cardIndex: 0, choice: 1 }).ok).toBe(true);
    const u = setup(3, { augs: { p1: ['alchemy'] }, deal: { board: cards(BOARD), hands: { p1: cards('Ks 3d'), p2: cards('Qc Jh'), p3: cards('6c Qd') } } });
    toWindow(u, 'river');
    expect((applyAction(u, 'p1', { type: 'declare', augment: 'alchemy', cardIndex: 0, choice: 1 }) as { error?: string }).error).toContain('공개된 카드');
  });

  it('탈취: 지목형 증강을 빼앗아 대상을 다시 고른다, 원래 선언자의 횟수는 소모, 먼저 쓴 쪽 우선', () => {
    const s = setup(3, { augs: { p1: ['blindDart'], p2: ['steal'], p3: ['counterSpell'] } });
    use(s, 'p1', 'blindDart', { targetId: 'p3' });
    expect(view(s, 'p2').reaction!.steal!.map((o) => o.targetId).sort()).toEqual(['p1', 'p3']);
    expect(view(s, 'p3').reaction!.steal).toBeNull();
    act(s, 'p2', { type: 'steal', targetId: 'p1' });
    expect(applyAction(s, 'p3', { type: 'counter' }).ok).toBe(false);
    resolveAll(s);
    expect(s.effects.blindDarted).toEqual(['p1']);
    expect(P(s, 'p1').augments[0].usesLeft).toBe(0);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
    // 카운터가 먼저면 탈취 불가
    const t = setup(3, { augs: { p1: ['blindDart'], p2: ['steal'], p3: ['counterSpell'] } });
    use(t, 'p1', 'blindDart', { targetId: 'p3' });
    act(t, 'p3', { type: 'counter' });
    expect(applyAction(t, 'p2', { type: 'steal', targetId: 'p1' }).ok).toBe(false);
  });

  it('탈취: 카드를 지정하는 증강(봉인)은 카드를 다시 고른다, 탈취할 수 없는 증강에는 못 쓴다', () => {
    const s = setup(3, { augs: { p1: ['seal', 'thermal'], p2: ['steal'] }, deal: { board: cards(BOARD) } });
    toWindow(s, 'river');
    act(s, getPending(s).playerIds[0] === 'p1' ? 'p1' : 'p1', { type: 'declare', augment: 'seal', boardIndex: 0 });
    act(s, 'p2', { type: 'steal', boardIndex: 3 });
    resolveAll(s);
    expect(s.effects.sealed).toEqual([3]);
    const t = setup(3, { augs: { p1: ['thermal'], p2: ['steal'] } });
    use(t, 'p1', 'thermal', { targetId: 'p3' });
    expect(applyAction(t, 'p2', { type: 'steal', targetId: 'p1' }).ok).toBe(false);
  });

  it('공개 청문회: 정보형 증강으로 나를 보면 확인은 허용, 쓴 사람의 같은 종류 정보를 전원에게', () => {
    const s = setup(3, { augs: { p1: ['clairvoyance'], p2: ['publicHearing'] }, deal: { hands: { p1: cards('9c 8d'), p2: cards('Kc 3h'), p3: cards('6c 5d') } } });
    use(s, 'p1', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toMatch(/\[Kc\]|\[3h\]/);
    const pub = view(s, 'p3').log.find((e) => e.text.startsWith('공개 청문회'))!;
    expect(pub.text).toMatch(/P1의 홀카드 중 1장은 \[(9c|8d)\]/);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
  });
});

// ───────────────────────── 6. 확률·통계 ─────────────────────────

describe('6. 확률·통계', () => {
  it('기록관: 상대별 프리플랍 참여율과 쇼다운에서 드러난 블러프 횟수를 보유자에게만', () => {
    const s = setup(3, { augs: { p1: ['recorder'] }, deal: { board: cards('As Kd 7c 4h 2s'), hands: { p1: cards('Ac Ah'), p2: cards('9c 8d'), p3: cards('Qc Jd') } } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'check' });
    passUntil(s, () => s.street === 'flop');
    act(s, 'p2', { type: 'raise', amount: 40 });
    act(s, 'p3', { type: 'call' });
    act(s, 'p1', { type: 'call' });
    toShowdown(s);
    const rec = view(s, 'p1').you.extra.recorder!;
    expect(rec.p2).toEqual({ hands: 1, vpip: 100, bluffs: 1 });
    expect(rec.p3).toEqual({ hands: 1, vpip: 0, bluffs: 0 });
    expect(rec.p1).toBeUndefined();
    expect(view(s, 'p2').you.extra.recorder).toBeNull();
  });

  it('운명의 실: 두 사람만 리버까지 맞붙는다고 가정한 정확한 승률을 나에게만 (증강 효과 반영)', () => {
    const s = setup(3, { augs: { p1: ['fateThread'] }, deal: { board: cards('Ad Ac Kd 4h 2s'), hands: { p1: cards('As Ah'), p2: cards('2c 3d'), p3: cards('Qc Jd') } } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'fateThread', { targetId: 'p2' });
    expect(view(s, 'p2').log.at(-1)!.text).toBe('P1님이 비공개 증강을 사용했습니다');
    resolveAll(s);
    expect(lastNote(s, 'p1')).toContain('100.0%');
    expect(JSON.stringify(view(s, 'p2'))).not.toContain('운명의 실:');

    // 무늬만 다른 같은 패는 정확히 50%
    const t = setup(3, { augs: { p1: ['fateThread'] }, deal: { board: cards('2c 7s 9c 4d 5s'), hands: { p1: cards('Kh Qh'), p2: cards('Kd Qd'), p3: cards('3c 3s') } } });
    passUntil(t, () => t.street === 'flop');
    use(t, 'p1', 'fateThread', { targetId: 'p2' });
    resolveAll(t);
    expect(lastNote(t, 'p1')).toContain('50.0%');

    // 족보 역전이 걸려 있으면 반영된다
    const u = setup(3, { augs: { p1: ['fateThread'] }, deal: { board: cards('Ad Ac Kd 4h 2s'), hands: { p1: cards('As Ah'), p2: cards('2c 3d'), p3: cards('Qc Jd') } } });
    passUntil(u, () => u.street === 'flop');
    u.effects.flips = 1;
    use(u, 'p1', 'fateThread', { targetId: 'p2' });
    resolveAll(u);
    expect(lastNote(u, 'p1')).toMatch(/승률은 0\.0%/);
  });
});
