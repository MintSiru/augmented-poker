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
