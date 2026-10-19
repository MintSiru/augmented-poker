// 4차 풀 증강 55개 테스트
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
  canHold,
  AUGMENTS,
  ALL_AUGMENT_IDS,
  poolIds,
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
  before?: (s: GameState) => void;
}

export function ok(r: { ok: boolean; error?: string }) {
  if (!r.ok) throw new Error(r.error);
}

/** 증강·칩·카드를 지정한 뒤 첫 핸드를 시작한다. 기본: p1 딜러 (3인: p2 SB, p3 BB, p1 먼저) */
export function setup(n: number, o: SetupOpts = {}): GameState {
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

export const act = (s: GameState, id: string, a: GameAction) => ok(applyAction(s, id, a));
export const use = (s: GameState, id: string, augment: AugmentId, extra: Record<string, unknown> = {}) =>
  act(s, id, { type: 'useAugment', augment, ...extra } as GameAction);
export const tryUse = (s: GameState, id: string, augment: AugmentId, extra: Record<string, unknown> = {}) =>
  applyAction(s, id, { type: 'useAugment', augment, ...extra } as GameAction);
export const P = (s: GameState, id: string) => s.players.find((p) => p.id === id)!;
export const cards = (x: string) => x.split(' ');
export const view = (s: GameState, id: string) => getPlayerView(s, id);
export const lastNote = (s: GameState, id: string) => P(s, id).notes.at(-1)!.text;
export const respond = (s: GameState, id: string, a: Record<string, unknown>) => act(s, id, { type: 'respond', ...a } as GameAction);

export function resolveAll(s: GameState) {
  for (let i = 0; i < 20 && s.phase === 'reaction'; i++) applyTimeouts(s);
}

/** 지금 차례인 사람이 체크(가능하면) 또는 콜, 선언 기회는 넘기기, 반응 대기는 끝내기를 반복 */
export function passUntil(s: GameState, pred: () => boolean, limit = 80) {
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

export const toShowdown = (s: GameState) => passUntil(s, () => s.phase === 'handEnd' || s.phase === 'gameOver');
export const toWindow = (s: GameState, stage: string) => passUntil(s, () => s.phase === 'declare' && s.windowStage === stage);
export const BOARD = 'As Kd 7c 4h 2s';

// ───────────────────────── 보유 규칙 ─────────────────────────

describe('4차 보유 규칙', () => {
  it('배타적 풀 6종(색맹 포함), 카운터형에 4종 추가, 동시 보유 불가 조합', () => {
    const variant = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].group === 'variant');
    expect(variant.sort()).toEqual(['colorBlind', 'doubleStep', 'fourFlush', 'fourStraight', 'gapStraight', 'parity'].sort());
    for (const a of ['pokerFace', 'selectiveReveal', 'infoToll', 'trap'] as AugmentId[]) {
      expect(AUGMENTS[a].group).toBe('counter');
      expect(canHold(['counterSpell'], a)).toBe(false);
    }
    for (const a of ['afterimage', 'pickpocket', 'deadScanner'] as AugmentId[]) {
      expect(canHold(['counting'], a)).toBe(false);
      expect(canHold([a], 'counting')).toBe(false);
    }
    expect(canHold(['sideBet'], 'straw')).toBe(false);
    expect(canHold(['straw'], 'sideBet')).toBe(false);
    expect(canHold(['afterimage'], 'pickpocket')).toBe(true);
  });
});

// ───────────────────────── 정보형 ─────────────────────────

describe('4차 정보형', () => {
  const HANDS = { p1: cards('9c 8d'), p2: cards('Qc Qh'), p3: cards('3c 5c') };

  it('잔상: 번 카드를 나만 본다', () => {
    const s = setup(3, { augs: { p1: ['afterimage'] }, deal: { board: cards(BOARD), burns: cards('Th Jh Ah'), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    expect(lastNote(s, 'p1')).toBe('잔상: 번 카드 [Th]');
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/\[Th\]|"Th"/);
    passUntil(s, () => s.street === 'turn');
    expect(lastNote(s, 'p1')).toBe('잔상: 번 카드 [Jh]');
  });

  it('후각·무늬 감별: 예/아니오만, 비공개 알림, 도청 보유자는 같은 결과와 사용자를 본다', () => {
    const s = setup(3, { augs: { p1: ['smell', 'suitCheck'], p3: ['wiretap'] }, deal: { hands: HANDS } });
    use(s, 'p1', 'smell', { targetId: 'p2' });
    expect(view(s, 'p2').log.at(-1)!.text).toBe('P1님이 비공개 증강을 사용했습니다');
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('후각: P2의 홀카드는 포켓 페어인가? 예');
    expect(lastNote(s, 'p3')).toBe('도청: P1이(가) P2에게 「후각」 — P2의 홀카드는 포켓 페어인가? 예');
    expect(tryUse(s, 'p1', 'smell', { targetId: 'p3' }).ok).toBe(false); // 핸드당 1회
    use(s, 'p1', 'suitCheck', { targetId: 'p3' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('무늬 감별: P3의 홀카드는 같은 무늬인가? 예');
  });

  it('복기 노트: 플랍 시점 족보 종류만, 플랍 전 폴드면 횟수 소모 없음', () => {
    const s = setup(3, { augs: { p1: ['reviewNote'] }, deal: { board: cards('Qd 7c 2h Ks 3s'), hands: HANDS } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    toShowdown(s);
    use(s, 'p1', 'reviewNote', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('복기 노트: P2이(가) 플랍 시점에 완성했던 족보: 트리플');
    use(s, 'p1', 'reviewNote', { targetId: 'p3' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toContain('플랍 전 폴드');
    expect(P(s, 'p1').augments[0].usesLeft).toBe(1);
  });

  it('데드 카드 스캐너: 플랍 직후 폴드한 카드 중 지정한 숫자·무늬의 개수만', () => {
    const s = setup(3, { augs: { p1: ['deadScanner'] }, deal: { board: cards(BOARD), hands: HANDS } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'fold' });
    act(s, 'p3', { type: 'check' });
    toWindow(s, 'flop');
    act(s, 'p1', { type: 'declare', augment: 'deadScanner', choice: 10 }); // Q
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('데드 카드 스캐너: 폴드한 카드 중 Q — 2장 (폴드 카드 2장 중)');
  });

  it('탄약 조사: 횟수 제한 증강의 남은 횟수 총합만, 포커페이스면 "정보 없음"', () => {
    const s = setup(3, { augs: { p1: ['ammoCheck'], p2: ['thermal', 'mulligan', 'observer'], p3: ['pokerFace', 'thermal'] } });
    use(s, 'p1', 'ammoCheck', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('탄약 조사: P2의 횟수 제한 증강 남은 사용 횟수 총합: 3회');
    use(s, 'p1', 'ammoCheck', { targetId: 'p3' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('탄약 조사: P3 — 정보 없음');
    expect(P(s, 'p1').augments[0].usesLeft).toBe(0);
  });

  it('블랙박스: 핸드가 끝난 뒤 남은 보드와, 그대로 깔렸다면 누가 1등이었는지', () => {
    const s = setup(3, { augs: { p1: ['blackBox'] }, deal: { board: cards('Qd 7c 2h 9s 9h'), hands: HANDS } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'check' });
    passUntil(s, () => s.street === 'flop');
    act(s, 'p2', { type: 'raise', amount: 40 });
    act(s, 'p3', { type: 'fold' });
    act(s, 'p1', { type: 'fold' });
    use(s, 'p1', 'blackBox');
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('블랙박스: 남은 보드 [9s][9h] — 그대로 깔렸다면 1등: P2'); // P2 Q 풀하우스 > 나(9 트리플)
  });

  it('연결 고리: 보드와 숫자가 같은 홀카드 수, 초점: 플랍 전 가장 높은·낮은 숫자', () => {
    const s = setup(3, { augs: { p1: ['link', 'focus'] }, deal: { board: cards('Qd 3d 2h 9s 9h'), hands: HANDS } });
    use(s, 'p1', 'focus');
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('초점: 이번 플랍의 가장 높은 숫자 Q, 가장 낮은 숫자 2');
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'link', { targetId: 'p3' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('연결 고리: P3의 홀카드 중 보드와 숫자가 같은 카드: 1장');
  });

  it('역정보는 후각·무늬 감별·온도계·연결 고리에 가짜 결과, 거울은 사용자의 같은 정보, 역추적은 사용 알림', () => {
    const s = setup(3, { augs: { p1: ['smell', 'thermometer', 'link'], p2: ['disinfo'], p3: ['mirror'] }, deal: { board: cards('Qd 3d 2h 9s 9h'), hands: HANDS } });
    use(s, 'p1', 'smell', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('후각: P2의 홀카드는 포켓 페어인가? 아니오');
    use(s, 'p1', 'thermometer', { targetId: 'p3' });
    resolveAll(s);
    expect(lastNote(s, 'p3')).toBe('거울: P1이(가) 「온도계」으로 나를 확인했습니다. P1의 홀카드 숫자 합은 15 이상');
    const t = setup(3, { augs: { p1: ['suitCheck'], p2: ['traceback'] }, deal: { hands: HANDS } });
    use(t, 'p1', 'suitCheck', { targetId: 'p2' });
    resolveAll(t);
    expect(lastNote(t, 'p2')).toBe('역추적: P1이(가) 나에게 「무늬 감별」을(를) 썼습니다.');
  });
});

// ───────────────────────── 방어/카운터형 ─────────────────────────

describe('4차 방어/카운터형', () => {
  const HANDS = { p1: cards('9c 8d'), p2: cards('Qc Jh'), p3: cards('3c 5c') };

  it('포커페이스: 탐문·관찰자·도청에 잡히지 않는다 ("정보 없음", 횟수 소모)', () => {
    const s = setup(3, { augs: { p1: ['inquiry', 'observer'], p2: ['pokerFace', 'thermal'], p3: ['wiretap'] }, deal: { hands: HANDS } });
    use(s, 'p1', 'inquiry', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toBe('탐문: P2 — 정보 없음');
    expect(P(s, 'p3').notes).toHaveLength(0);
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'fold' });
    toShowdown(s);
    expect(P(s, 'p1').notes.some((n) => n.text === '관찰자: P2 — 정보 없음')).toBe(true);
  });

  it('선택적 노출: 투시를 쓰면 보여 줄 카드를 내가 고른다 (10초, 응답이 없으면 무작위)', () => {
    const s = setup(3, { augs: { p1: ['clairvoyance'], p2: ['selectiveReveal'] }, deal: { hands: HANDS } });
    use(s, 'p1', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    expect(getPending(s)).toMatchObject({ kind: 'respond', playerIds: ['p2'] });
    expect(s.respond!.seconds).toBe(10);
    // 다른 사람에게는 누가 누구를 확인하는지 보이지 않는다
    expect(view(s, 'p3').respond).toMatchObject({ augment: null, participants: [], text: '응답 대기 중' });
    expect(view(s, 'p2').respond!.input).toBe('card');
    respond(s, 'p2', { cardIndex: 1 });
    expect(lastNote(s, 'p1')).toBe('투시: P2의 홀카드 중 1장은 [Jh]');
    expect(P(s, 'p2').augments[0].usesLeft).toBe(1);
  });

  it('정보 통행료: 사용자가 2BB를 내고 진행하거나, 취소하면 사용 횟수를 돌려받는다 (응답 없으면 취소)', () => {
    const s = setup(3, { augs: { p1: ['thermal'], p2: ['infoToll'] }, deal: { hands: HANDS } });
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    resolveAll(s);
    expect(getPending(s)).toMatchObject({ kind: 'respond', playerIds: ['p1'] });
    expect(view(s, 'p3').respond!.participants).toEqual([]);
    respond(s, 'p1', { accept: true });
    expect(P(s, 'p1').chips).toBe(1000 - 40);
    expect(P(s, 'p2').chips).toBe(990 + 40);
    expect(lastNote(s, 'p1')).toBe('열화상 카메라: P2의 홀카드 — 하이 2장, 로우 0장');
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    resolveAll(s);
    applyTimeouts(s);
    expect(P(s, 'p1').augments[0].usesLeft).toBe(2);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
    // 통행료를 다 쓰면 그냥 확인된다
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    resolveAll(s);
    expect(s.phase).toBe('betting');
  });

  it('덫: 비공개 설치, 나를 대상으로 한 지목형·정보형 증강의 사용자가 가진 증강 전체를 본다', () => {
    const s = setup(3, { augs: { p1: ['thermal', 'mulligan'], p2: ['trap'] }, deal: { hands: HANDS } });
    use(s, 'p2', 'trap');
    expect(s.phase).toBe('betting');
    expect(view(s, 'p1').log.some((e) => e.text.includes('덫'))).toBe(false);
    expect(view(s, 'p2').you.extra.trapArmed).toBe(true);
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    resolveAll(s);
    expect(lastNote(s, 'p1')).toContain('열화상 카메라');
    expect(lastNote(s, 'p2')).toBe('덫: P1이(가) 나에게 증강을 썼습니다. P1의 보유 증강 — 열화상 카메라 ★, 멀리건 ★');
    expect(view(s, 'p2').you.extra.trapArmed).toBe(false);
  });
});

// ───────────────────────── 족보 변형형 ─────────────────────────

import { evaluatePlayerHand, Category } from '../src/index.js';

describe('4차 족보 변형형', () => {
  const ev = (hole: string, board: string, rules: Record<string, unknown>) => evaluatePlayerHand(cards(hole), cards(board), rules as never);

  it('숫자 거울: 6과 9를 같은 숫자로 (페어 계열만, 스트레이트에는 안 씀)', () => {
    const r = ev('6c 9d', '6h 2s Kc Jd 3h', { numberMirror: true });
    expect(r.value.category).toBe(Category.Trips);
    expect(r.applied).toContain('numberMirror');
    expect(ev('6c 9d', '6h 2s Kc Jd 3h', {}).value.category).toBe(Category.Pair);
    // 5-6-7-8 + 9 는 원래 스트레이트, 6을 9로 바꿔 쓰는 스트레이트는 없다
    expect(ev('6c 5d', '7h 8s 2c Jd Qh', { numberMirror: true }).value.category).toBe(Category.HighCard);
  });

  it('약자의 왕관: 내 홀카드의 2는 하이카드·키커 비교에서 A보다 높다 (족보 구성에는 영향 없음)', () => {
    const crowned = ev('2c Kd', 'As Qh 9s 7c 4d', { crown: ['2c'] });
    const plain = ev('3c Kd', 'As Qh 9s 7c 4d', {});
    expect(crowned.value.score[1]).toBe(15);
    expect(crowned.value.score > plain.value.score).toBe(true);
    // 스트레이트(A-2-3-4-5)는 원래대로
    expect(ev('2c 3d', 'As 4h 5s Kc Jd', { crown: ['2c'] }).value.category).toBe(Category.Straight);
  });

  it('이웃사촌: 1 차이 두 장을 높은 쪽 원페어로 (하이카드일 때만), 삼쌍둥이: 페어 3쌍이면 풀하우스', () => {
    const n = ev('7c 8d', 'Ks 2h 4c Jd Qs', { neighbors: true });
    // K-Q 가 이웃 → K 원페어, 나머지 J·8·7 이 키커
    expect(n.value.score).toEqual([Category.Pair, 13, 11, 8, 7]);
    expect(n.applied).toContain('neighbors');
    // 이미 페어가 있으면 투페어를 만들지 않는다
    expect(ev('7c 8d', 'Ks Kh 4c Jd 2s', { neighbors: true }).value.category).toBe(Category.Pair);
    const t = ev('Kc 9d', 'Ks 9h 4c 4d 2s', { triplets: true });
    expect(t.value.score).toEqual([Category.FullHouse, 13, 9]);
    expect(t.applied).toContain('triplets');
  });

  it('왕실: J·Q·K는 같은 숫자 (J-Q-K 트리플), J·Q·K 중 2장 이상이 필요한 스트레이트는 불가', () => {
    expect(ev('Jc Qd', 'Ks 2h 4c 8d 7s', { royalty: true }).value.score.slice(0, 2)).toEqual([Category.Trips, 13]);
    // 9-T-J-Q-K 스트레이트 대신 트리플
    expect(ev('Tc Jd', '9s Qh Kc 2d 3h', { royalty: true }).value.category).toBe(Category.Trips);
    expect(ev('Tc Jd', '9s Qh Kc 2d 3h', {}).value.category).toBe(Category.Straight);
  });

  it('색맹: 색으로 플러시 (일반 플러시와 같은 등급, 완전히 같으면 일반 플러시가 높다)', () => {
    const c = ev('2h 5d', '9h Kd 7h 3c Jc', { colorFlush: true });
    expect(c.value.category).toBe(Category.Flush);
    expect(c.applied).toContain('colorFlush');
    const real = ev('2h 5h', '9h Kh 7h 3c Jc', {});
    expect(real.value.score > ev('2h 5d', '9h Kh 7h 3c Jc', { colorFlush: true }).value.score).toBe(true);
  });

  it('색맹·그림자 분신·오마하의 피는 게임에서 선언하고, 족보 역전·변형과 함께 판정된다', () => {
    const s = setup(3, {
      augs: { p1: ['colorBlind'], p2: ['shadow'], p3: ['omahaBlood'] },
      deal: { board: cards('9h Kd 7s 7c Qs'), hands: { p1: cards('2h 5d'), p2: cards('7h 3d'), p3: cards('Kc Qd') } },
    });
    use(s, 'p1', 'colorBlind');
    resolveAll(s);
    toWindow(s, 'preShowdown');
    const first = getPending(s).playerIds[0];
    expect(first).toBe('p2');
    // 그림자 분신: 7h 를 7s 의 무늬로 → 그대로 트리플이지만 무늬가 바뀐 카드로 판정
    expect(view(s, 'p2').you.declare!.shadow).toEqual([{ cardIndex: 0, boardIndex: 2 }, { cardIndex: 0, boardIndex: 3 }]);
    act(s, 'p2', { type: 'declare', augment: 'shadow', cardIndex: 0, boardIndex: 2 });
    resolveAll(s);
    // 오마하의 피: K·Q 두 장 + 보드 3장 = 투페어(K, Q) → 한 단계 위 트리플
    act(s, 'p3', { type: 'declare', augment: 'omahaBlood' });
    resolveAll(s);
    toShowdown(s);
    const e3 = s.result!.entries.find((e) => e.id === 'p3')!;
    expect(e3.handName).toContain('오마하의 피');
    expect(e3.score[0]).toBe(Category.Trips);
    expect(s.result!.entries.find((e) => e.id === 'p2')!.applied).toContain('shadow');
  });
});

// ───────────────────────── 카드 조작형 ─────────────────────────

describe('4차 카드 조작형', () => {
  const HANDS = { p1: cards('9c 8d'), p2: cards('Qc Jh'), p3: cards('3c 5c') };

  it('교환 진열대: 덱에서 2장 공개, 1장과 홀카드를 바꾸거나 거절 (가져간 카드는 공개된 카드)', () => {
    const s = setup(3, { augs: { p1: ['showcase'] }, deal: { board: cards(BOARD), hands: HANDS, deck: cards('Ah Kh') } });
    use(s, 'p1', 'showcase');
    resolveAll(s);
    expect(view(s, 'p3').offerCards).toEqual(['Ah', 'Kh']);
    expect(view(s, 'p1').respond).toMatchObject({ input: 'pickSwap', offered: ['Ah', 'Kh'] });
    respond(s, 'p1', { choice: 0, cardIndex: 1 });
    expect(P(s, 'p1').hole).toEqual(['9c', 'Ah']);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.exposed).toEqual(['Ah']);
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/\[8d\]|"8d"/);
    expect(s.offerCards).toEqual([]);
    // 거절해도 횟수는 소모 (시간 초과 = 거절)
    const t = setup(3, { augs: { p1: ['showcase'] }, deal: { hands: HANDS } });
    use(t, 'p1', 'showcase');
    resolveAll(t);
    applyTimeouts(t);
    expect(P(t, 'p1').hole).toEqual(['9c', '8d']);
    expect(P(t, 'p1').augments[0].usesLeft).toBe(0);
  });

  it('봉인 봉투: 예비 카드를 나만 보고 보관, 플랍 라운드 동안 교체 (안 하면 버림)', () => {
    const s = setup(3, { augs: { p1: ['envelope'] }, deal: { board: cards(BOARD), hands: HANDS, deck: cards('Ah') } });
    use(s, 'p1', 'envelope');
    resolveAll(s);
    expect(view(s, 'p1').you.extra.envelope).toBe('Ah');
    expect(JSON.stringify(view(s, 'p2'))).not.toMatch(/\[Ah\]|"Ah"/);
    expect(applyAction(s, 'p1', { type: 'envelope', cardIndex: 0 }).ok).toBe(false); // 플랍 전
    passUntil(s, () => s.street === 'flop');
    act(s, 'p1', { type: 'envelope', cardIndex: 1 });
    expect(P(s, 'p1').hole).toEqual(['9c', 'Ah']);
    expect(P(s, 'p1').envelope).toBeNull();
  });

  it('선불 교환: 홀카드 1장을 공개·버리고 1장으로 프리플랍, 플랍 직전에 새 카드', () => {
    const s = setup(3, { augs: { p1: ['prepay'] }, deal: { board: cards(BOARD), hands: HANDS, deck: cards('Ah') } });
    use(s, 'p1', 'prepay', { cardIndex: 1 });
    resolveAll(s);
    expect(P(s, 'p1').hole).toEqual(['9c']);
    expect(view(s, 'p2').log.some((e) => e.text.includes('[8d]'))).toBe(true);
    passUntil(s, () => s.street === 'flop');
    expect(P(s, 'p1').hole).toEqual(['9c', 'Ah']);
  });

  it('냉동 보관: 플랍·턴에 홀카드 1장을 보관하고 새 카드, 이후 핸드 프리플랍에 꺼낸다 (보관 중에는 덱에서 제외)', () => {
    const s = setup(3, { augs: { p1: ['coldStorage'] }, deal: { board: cards(BOARD), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'coldStorage', { cardIndex: 0 });
    resolveAll(s);
    expect(P(s, 'p1').frozen).toBe('9c');
    expect(P(s, 'p1').hole[0]).not.toBe('9c');
    toShowdown(s);
    ok(startNextHand(s));
    const all = [...s.board, ...s.burns, ...s.deck, ...s.players.flatMap((p) => p.hole)];
    expect(all).not.toContain('9c');
    expect(view(s, 'p1').you.extra.frozen).toBe('9c');
    const first = s.players[s.toAct!].id;
    act(s, 'p1', { type: 'coldStorage', cardIndex: 1 });
    expect(P(s, 'p1').hole[1]).toBe('9c');
    expect(P(s, 'p1').frozen).toBeNull();
    void first;
  });

  it('재활용: 플랍 후 번 카드를 확인하고 1장을 홀카드와 바꾼다 (버린 카드는 덱으로 안 돌아감)', () => {
    const s = setup(3, { augs: { p2: ['recycle'] }, deal: { board: cards(BOARD), burns: cards('Ah Th Jd'), hands: HANDS } });
    passUntil(s, () => s.street === 'flop');
    use(s, 'p2', 'recycle');
    resolveAll(s);
    expect(view(s, 'p2').respond!.offered).toEqual(['Ah']);
    expect(view(s, 'p1').respond!.offered).toBeNull();
    respond(s, 'p2', { choice: 0, cardIndex: 1 });
    expect(P(s, 'p2').hole).toEqual(['Qc', 'Ah']);
    expect(s.used.some((u) => u.card === 'Ah')).toBe(false);
    expect(s.used.some((u) => u.card === 'Jh' && u.kind === 'discard')).toBe(true);
  });

  it('소매치기: 쇼다운 직전 폴드한 사람과 홀카드를 통째로 바꾼다', () => {
    const s = setup(3, { augs: { p1: ['pickpocket'] }, deal: { board: cards(BOARD), hands: HANDS } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'fold' });
    toWindow(s, 'preShowdown');
    expect(view(s, 'p1').you.declare!.targets.pickpocket).toEqual(['p2']);
    act(s, 'p1', { type: 'declare', augment: 'pickpocket', targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p1').hole).toEqual(['Qc', 'Jh']);
    expect(P(s, 'p2').hole).toEqual(['9c', '8d']);
    toShowdown(s);
    expect(s.result!.entries.find((e) => e.id === 'p1')!.cards).toEqual(['Qc', 'Jh']);
  });
});

describe('4차 경제/베팅형', () => {
  // p1 딜러, p2 SB, p3 BB. 보드 As Kd 7c 4h 2s 에서 p2(QQ) > p1(9 하이) > p3(9 하이, 낮은 키커)
  const HANDS = { p1: cards('9c 8d'), p2: cards('Qc Qh'), p3: cards('9d 6c') };
  const deal = (hands: Record<string, string[]> = HANDS, board = BOARD) => ({ board: cards(board), hands });
  /** 다음 핸드의 카드를 정하고 시작한다 */
  const next = (s: GameState, d: DebugDeal) => {
    ok(debugSetNextDeal(s, d));
    resolveAll(s);
    ok(startNextHand(s));
    resolveAll(s);
  };

  it('예약 주문: 첫 행동 전에 숫자를 공개로 고르고, 플랍에 나오면 팟에서 1BB', () => {
    const s = setup(3, { augs: { p1: ['reserveOrder'] }, deal: deal() });
    use(s, 'p1', 'reserveOrder', { choice: 7 });
    resolveAll(s);
    expect(view(s, 'p3').players.find((p) => p.id === 'p1')!.reserveRank).toBe(7);
    act(s, 'p1', { type: 'call' });
    expect(tryUse(s, 'p1', 'reserveOrder', { choice: 7 }).ok).toBe(false);
    passUntil(s, () => s.street === 'flop');
    expect(P(s, 'p1').chips).toBe(1000);
  });

  it('현상수배: 다음 핸드 쇼다운에서 대상을 이기면 5BB를 대상에게서', () => {
    const s = setup(3, { augs: { p1: ['wanted'] }, deal: deal() });
    toShowdown(s);
    use(s, 'p1', 'wanted', { targetId: 'p3' });
    resolveAll(s);
    expect(view(s, 'p1').you.extra.wanted).toBe('P3');
    const before = P(s, 'p3').chips;
    next(s, deal({ p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') }));
    expect(P(s, 'p1').wanted).toBe('p3');
    toShowdown(s);
    expect(s.result!.extras.some((t) => t.includes('현상수배'))).toBe(true);
    // p3 는 블라인드 20 + 현상금 100
    expect(P(s, 'p3').chips).toBe(before - 20 - 100);
  });

  it('사이드 베팅: 폴드 후 2BB를 걸고, 예측이 맞으면 4BB (예측은 본인만)', () => {
    const s = setup(3, { augs: { p1: ['sideBet'] }, deal: deal() });
    expect(tryUse(s, 'p1', 'sideBet', { targetId: 'p2' }).ok).toBe(false);
    act(s, 'p1', { type: 'fold' });
    use(s, 'p1', 'sideBet', { targetId: 'p2' });
    resolveAll(s);
    expect(view(s, 'p1').you.extra.sideBetOn).toBe('P2');
    expect(view(s, 'p2').you.extra.sideBetOn).toBeNull();
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 - 40 + 80);
  });

  it('한도 설정: 다음 핸드 최대 20BB까지만 내고, 넘는 베팅은 사이드 팟', () => {
    const s = setup(3, { augs: { p1: ['betCap'] }, deal: deal() });
    toShowdown(s);
    use(s, 'p1', 'betCap');
    resolveAll(s);
    const before = P(s, 'p1').chips;
    // 다음 핸드: p2 딜러, p3 SB, p1 BB, p2 먼저
    next(s, deal());
    expect(P(s, 'p1').betCap).toBe(400);
    expect(view(s, 'p1').you.extra.betCap).toBe(400);
    act(s, 'p2', { type: 'raise', amount: 800 });
    act(s, 'p3', { type: 'fold' });
    const l = legalActions(s, 'p1')!;
    expect(l.allInAmount).toBe(400);
    act(s, 'p1', { type: 'call' });
    expect(P(s, 'p1').contributed).toBe(400);
    toShowdown(s);
    // p2(QQ) 승: p1 은 400만 잃고, 남는 400 은 p2 의 사이드 팟(돌려받음)
    expect(P(s, 'p1').chips).toBe(before - 400);
    expect(P(s, 'p1').betCap).toBe(400);
  });

  it('연승 수당·폭주기관차: 한 연승 카운터, 연승 수당은 작은 팟도 센다', () => {
    const win = { p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') };
    const s = setup(3, { augs: { p1: ['winBonus', 'runaway'] }, deal: deal(win) });
    toShowdown(s);
    expect(P(s, 'p1').streak).toBe(1);
    next(s, deal(win));
    toShowdown(s);
    expect(P(s, 'p1').streak).toBe(2);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.streak).toBe(2);
    expect(s.result!.extras.some((t) => t.includes('연승 수당'))).toBe(true);
  });

  it('적금: 프리플랍 폴드마다 0.1BB 적립 (본인만), 팟을 이기면 은행에서', () => {
    const s = setup(3, { augs: { p1: ['savings'] }, deal: deal() });
    act(s, 'p1', { type: 'fold' });
    expect(P(s, 'p1').savings).toBe(1);
    expect(view(s, 'p1').you.extra.savings).toBe(2);
    expect(view(s, 'p2').you.extra.savings).toBe(0);
    toShowdown(s);
    next(s, deal({ p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') }));
    toShowdown(s);
    expect(s.result!.extras.some((t) => t.includes('적금 2칩'))).toBe(true);
    expect(P(s, 'p1').savings).toBe(0);
  });

  it('소액 전문: 6BB 이하 팟 단독 승리 시 1BB', () => {
    const s = setup(3, { augs: { p1: ['smallPot'] }, deal: deal({ p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') }) });
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 + 40 + 20);
  });

  it('재정비: 쇼다운에서 지고 칩이 남으면 2BB', () => {
    const s = setup(3, { augs: { p1: ['regroup'] }, deal: deal() });
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 - 20 + 40);
  });

  it('공동 수확: 동점으로 나눠 받으면 2BB', () => {
    const s = setup(3, {
      augs: { p1: ['coHarvest'] },
      deal: deal({ p1: cards('9c 8d'), p2: cards('9d 8h'), p3: cards('3c 5c') }, 'As Kd Qc Jh 2s'),
    });
    toShowdown(s);
    expect(s.result!.extras.some((t) => t.includes('공동 수확'))).toBe(true);
    expect(P(s, 'p1').chips).toBe(1000 + 10 + 40);
  });

  it('복수: 쇼다운에서 나를 이긴 사람을 다음에 이기면 팟의 15% (대상은 본인만)', () => {
    const s = setup(3, { augs: { p1: ['revenge'] }, deal: deal() });
    toShowdown(s);
    expect(P(s, 'p1').nemesis).toBe('p2');
    expect(view(s, 'p1').you.extra.nemesis).toBe('P2');
    expect(view(s, 'p2').you.extra.nemesis).toBeNull();
    next(s, deal({ p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') }));
    toShowdown(s);
    expect(s.result!.extras.some((t) => t.includes('복수') && t.includes('9칩'))).toBe(true);
  });

  it('배짱 시험: 리버 베팅 직후 카드 1장 공개, 모두 폴드하면 마지막 폴드한 사람이 3BB', () => {
    const s = setup(3, { augs: { p1: ['nerveTest'] }, deal: deal() });
    passUntil(s, () => s.street === 'river' && s.phase === 'betting' && s.players[s.toAct!].id === 'p1');
    expect(tryUse(s, 'p1', 'nerveTest', { cardIndex: 0 }).ok).toBe(false);
    act(s, 'p1', { type: 'raise', amount: 40 });
    use(s, 'p1', 'nerveTest', { cardIndex: 0 });
    resolveAll(s);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.exposed).toEqual(['9c']);
    act(s, 'p2', { type: 'fold' });
    const p3 = P(s, 'p3').chips;
    act(s, 'p3', { type: 'fold' });
    expect(P(s, 'p3').chips).toBe(p3 - 60);
    expect(s.result!.extras.some((t) => t.includes('배짱 시험'))).toBe(true);
  });

  it('빨대 꼽기: 폴드 후 지목한 사람이 이기면 내가 낸 칩을 그 몫에서 돌려받는다', () => {
    const s = setup(3, { augs: { p3: ['straw'] }, deal: deal() });
    act(s, 'p1', { type: 'raise', amount: 60 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    use(s, 'p3', 'straw', { targetId: 'p2' });
    resolveAll(s);
    expect(view(s, 'p3').you.extra.strawOn).toBe('P2');
    expect(view(s, 'p1').you.extra.strawOn).toBeNull();
    toShowdown(s);
    expect(P(s, 'p3').chips).toBe(1000);
    expect(P(s, 'p2').chips).toBe(1000 + 60 + 20 - 20);
  });

  it('대격변: ★→★★, ★★→★★★, 대격변은 사라지고 잠복 숨김은 유지, 풀에서 꺼진 증강은 안 나온다', () => {
    const s = setup(3, { augs: { p1: ['savings', 'revenge', 'cataclysm'] }, deal: deal() });
    P(s, 'p1').augments[0].hidden = true;
    const allowed = ALL_AUGMENT_IDS.filter((id) => (AUGMENTS[id].pool ?? 1) <= 2);
    s.options.pool = allowed;
    toShowdown(s);
    use(s, 'p1', 'cataclysm');
    resolveAll(s);
    const augs = P(s, 'p1').augments;
    expect(augs.map((a) => AUGMENTS[a.id].stars)).toEqual([2, 3]);
    expect(augs.some((a) => a.id === 'cataclysm')).toBe(false);
    expect(augs[0].hidden).toBe(true);
    for (const a of augs) expect(allowed).toContain(a.id);
    expect(lastNote(s, 'p1')).toContain('대격변');
  });

  it('대격변: ★★★는 몰?루 상자 — 별 등급이 무작위 (1/3씩)', () => {
    const counts: number[] = [0, 0, 0, 0];
    for (let seed = 1; seed <= 60; seed++) {
      const s = setup(3, { seed, augs: { p1: ['foresight', 'cataclysm'] }, deal: deal() });
      toShowdown(s);
      use(s, 'p1', 'cataclysm');
      resolveAll(s);
      counts[AUGMENTS[P(s, 'p1').augments[0].id].stars]++;
    }
    expect(counts[1]).toBeGreaterThan(5);
    expect(counts[2]).toBeGreaterThan(5);
    expect(counts[3]).toBeGreaterThan(5);
  });
});

describe('4차 심리전형', () => {
  it('연막탄: 이긴 쇼다운에서 족보에 안 쓴 홀카드는 다른 사람 뷰·로그에 끝까지 안 보낸다', () => {
    const s = setup(3, {
      augs: { p2: ['smokeBomb'] },
      deal: { board: cards('As Kd Qd 7c 2s'), hands: { p1: cards('9c 8d'), p2: cards('Qc 3h'), p3: cards('9d 6c') } },
    });
    toShowdown(s);
    expect(s.result!.won.p2).toBeGreaterThan(0);
    const v1 = view(s, 'p1');
    expect(v1.players.find((p) => p.id === 'p2')!.shownCards).toEqual(['Qc', '??']);
    expect(v1.result!.entries.find((e) => e.id === 'p2')!.cards).toEqual(['Qc', '??']);
    expect(JSON.stringify(v1)).not.toContain('3h');
    // 판정은 정상, 본인은 그대로 본다
    expect(view(s, 'p2').players.find((p) => p.id === 'p2')!.shownCards).toEqual(['Qc', '3h']);
    // 다음 핸드로 넘어가도 남지 않는다
    ok(startNextHand(s));
    resolveAll(s);
    expect(JSON.stringify(view(s, 'p1'))).not.toContain('"3h"');
  });

  it('연막탄: 진 쇼다운에서는 숨기지 않는다', () => {
    const s = setup(3, { augs: { p1: ['smokeBomb'] }, deal: { board: cards(BOARD), hands: { p1: cards('9c 8d'), p2: cards('Qc Qh'), p3: cards('9d 6c') } } });
    toShowdown(s);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.shownCards).toEqual(['9c', '8d']);
  });

  it('미끼 공개: 첫 행동 전에 1장 공개, 쇼다운에서 이기면 따라온 상대마다 1BB', () => {
    const s = setup(3, { augs: { p1: ['bait'] }, deal: { board: cards(BOARD), hands: { p1: cards('Qc Qh'), p2: cards('9c 8d'), p3: cards('9d 6c') } } });
    use(s, 'p1', 'bait', { cardIndex: 0 });
    resolveAll(s);
    expect(view(s, 'p2').players.find((p) => p.id === 'p1')!.exposed).toEqual(['Qc']);
    toShowdown(s);
    expect(P(s, 'p1').chips).toBe(1000 + 40 + 40);
    expect(P(s, 'p1').augments[0].usesLeft).toBe(1);
  });
});

describe('4차 공개형', () => {
  const HANDS = { p1: cards('9c 8d'), p2: cards('Qc Jh'), p3: cards('3c 5c') };
  const D = { board: cards(BOARD), hands: HANDS };
  const pub = (s: GameState, viewer: string, id: string) => view(s, viewer).players.find((p) => p.id === id)!;

  it('인디언 포커: 이마 카드는 본인 뷰에서만 빠지고(족보 표시도 숨김) 남에게는 보인다, 면역이면 두 장 다 봄', () => {
    const s = setup(3, { augs: { p1: ['indianPoker'], p3: ['immunity'] }, deal: D });
    toShowdown(s);
    use(s, 'p1', 'indianPoker');
    act(s, 'p3', { type: 'immunity' });
    resolveAll(s);
    ok(debugSetNextDeal(s, D));
    ok(startNextHand(s));
    resolveAll(s);
    const fh = P(s, 'p1').forehead!;
    expect(cards('9c 8d')).toContain(fh);
    expect(P(s, 'p3').forehead).toBeNull();
    const v1 = view(s, 'p1');
    expect(v1.you.hole).toContain('??');
    expect(v1.you.hand).toBeNull();
    expect(JSON.stringify(v1)).not.toContain(`"${fh}"`);
    expect(pub(s, 'p1', 'p1').hasForehead).toBe(true);
    expect(pub(s, 'p2', 'p1').forehead).toBe(fh);
    expect(view(s, 'p3').you.hole).toEqual(cards('3c 5c'));
    // 쇼다운에서는 모두 공개
    toShowdown(s);
    expect(pub(s, 'p1', 'p1').shownCards).toEqual(cards('9c 8d'));
  });

  it('딜러의 변덕: 3핸드 동안 버튼·블라인드·순서가 반시계, 그 뒤 그 자리에서 다시 시계 방향 (면역 불가)', () => {
    const s = setup(4, { augs: { p1: ['dealerWhim'], p3: ['immunity'] } });
    const name = (i: number) => s.players[i].id;
    toShowdown(s);
    use(s, 'p1', 'dealerWhim');
    expect(applyAction(s, 'p3', { type: 'immunity' }).ok).toBe(false);
    resolveAll(s);
    const seen: string[][] = [];
    for (let h = 0; h < 4; h++) {
      ok(startNextHand(s));
      resolveAll(s);
      seen.push([name(s.dealerIdx), name(s.sbIdx), name(s.bbIdx), name(s.toAct!)]);
      if (h === 0) expect(view(s, 'p2').table.whimHands).toBe(3);
      toShowdown(s);
    }
    // p1 딜러에서 시작: p4 → p3 → p2 (반시계), 그 다음 p3 (시계)
    expect(seen[0]).toEqual(['p4', 'p3', 'p2', 'p1']);
    expect(seen[1][0]).toBe('p3');
    expect(seen[2][0]).toBe('p2');
    expect(seen[3]).toEqual(['p3', 'p4', 'p1', 'p2']);
    expect(s.reversed).toBe(false);
  });

  it('딜러의 변덕: 헤즈업에서도 딜러가 SB', () => {
    const s = setup(2, { augs: { p1: ['dealerWhim'] } });
    toShowdown(s);
    use(s, 'p1', 'dealerWhim');
    resolveAll(s);
    for (let h = 0; h < 3; h++) {
      ok(startNextHand(s));
      resolveAll(s);
      expect(s.sbIdx).toBe(s.dealerIdx);
      toShowdown(s);
    }
  });

  it('공동 우물: 낸 카드를 섞어 다시 나눈다 (방탄조끼·면역은 빠짐, 고른 카드는 본인 뷰에만)', () => {
    const s = setup(4, {
      augs: { p2: ['commonWell'], p3: ['vest'], p4: ['immunity'] },
      deal: { board: cards(BOARD), hands: { ...HANDS, p4: cards('Td Ts') } },
    });
    passUntil(s, () => s.street === 'flop' && s.phase === 'betting');
    use(s, 'p2', 'commonWell');
    act(s, 'p4', { type: 'immunity' });
    resolveAll(s);
    expect(s.respond!.participants.sort()).toEqual(['p1', 'p2']);
    expect(P(s, 'p3').augments[0].usesLeft).toBe(0);
    respond(s, 'p1', { cardIndex: 0 });
    expect(view(s, 'p1').respond!.myAnswer!.cardIndex).toBe(0);
    expect(view(s, 'p2').respond!.myAnswer).toBeNull();
    respond(s, 'p2', { cardIndex: 1 });
    const all = [...P(s, 'p1').hole, ...P(s, 'p2').hole].sort();
    expect(all).toEqual(cards('9c 8d Qc Jh').sort());
    expect(P(s, 'p3').hole).toEqual(cards('3c 5c'));
    expect(P(s, 'p4').hole).toEqual(cards('Td Ts'));
  });

  it('도둑잡기: 고른 카드를 동시에 옆 사람(왼쪽)에게 넘긴다', () => {
    const s = setup(3, { augs: { p1: ['catchThief'] }, deal: D });
    use(s, 'p1', 'catchThief', { choice: 0 });
    resolveAll(s);
    respond(s, 'p1', { cardIndex: 0 });
    respond(s, 'p2', { cardIndex: 0 });
    respond(s, 'p3', { cardIndex: 0 });
    expect(P(s, 'p2').hole).toEqual(cards('9c Jh'));
    expect(P(s, 'p3').hole).toEqual(cards('Qc 5c'));
    expect(P(s, 'p1').hole).toEqual(cards('3c 8d'));
  });

  it('침묵의 리버: 턴 베팅 뒤 선언, 리버는 공개하지만 리버 베팅 없이 쇼다운', () => {
    const s = setup(3, { augs: { p1: ['silentRiver'] }, deal: D });
    toWindow(s, 'turnEnd');
    act(s, 'p1', { type: 'declare', augment: 'silentRiver' });
    resolveAll(s);
    toShowdown(s);
    expect(s.result!.showdown).toBe(true);
    expect(s.result!.board.length).toBe(5);
    expect(s.log.some((l) => l.text.includes('리버 베팅 없이 쇼다운으로 갑니다'))).toBe(true);
    const riverIdx = s.log.findIndex((l) => l.text.startsWith('리버'));
    expect(s.log.slice(riverIdx).some((l) => /: (체크|콜|베팅)/.test(l.text))).toBe(false);
  });

  it('휴전: 플랍·턴에서 베팅이 없을 때 내 차례에 선언하면 모두 체크로 다음 카드', () => {
    const s = setup(3, { augs: { p2: ['truce'] }, deal: D });
    passUntil(s, () => s.street === 'flop' && s.phase === 'betting');
    expect(s.players[s.toAct!].id).toBe('p2');
    use(s, 'p2', 'truce');
    resolveAll(s);
    expect(s.street).toBe('turn');
  });

  it('공용 카드: 각자 1장을 공개해 모두가 보드처럼 쓰고, 면역이면 카드를 내지 않는다', () => {
    const s = setup(3, { augs: { p1: ['sharedCard'], p3: ['immunity'] }, deal: D });
    use(s, 'p1', 'sharedCard');
    act(s, 'p3', { type: 'immunity' });
    resolveAll(s);
    respond(s, 'p1', { cardIndex: 0 });
    expect(view(s, 'p2').respond!.myAnswer).toBeNull();
    expect(JSON.stringify(view(s, 'p2'))).not.toContain('"9c"');
    respond(s, 'p2', { cardIndex: 1 });
    expect(s.effects.shared).toEqual(cards('9c Jh'));
    expect(P(s, 'p1').hole).toEqual(['8d']);
    expect(P(s, 'p3').hole.length).toBe(2);
    expect(view(s, 'p3').table.shared).toEqual(cards('9c Jh'));
    toShowdown(s);
    // p3 는 3c 5c + 보드 A 4 2 = 휠 스트레이트, 공용 9 J 도 함께 판정
    expect(s.result!.won.p3).toBeGreaterThan(0);
  });

  it('반쪽짜리 비밀: 각자 고른 1장을 동시에 공개', () => {
    const s = setup(3, { augs: { p1: ['halfSecret'] }, deal: D });
    use(s, 'p1', 'halfSecret');
    resolveAll(s);
    respond(s, 'p1', { cardIndex: 1 });
    respond(s, 'p2', { cardIndex: 0 });
    respond(s, 'p3', { cardIndex: 1 });
    expect(pub(s, 'p3', 'p1').exposed).toEqual(['8d']);
    expect(pub(s, 'p1', 'p2').exposed).toEqual(['Qc']);
    expect(pub(s, 'p2', 'p3').exposed).toEqual(['5c']);
  });

  it('한 번만 더: 레이즈 1번 뒤에는 콜·폴드만, 상한을 넘는 올인은 콜 금액만 낸다', () => {
    const s = setup(3, { augs: { p1: ['oneMore'] }, deal: D });
    use(s, 'p1', 'oneMore');
    resolveAll(s);
    act(s, 'p1', { type: 'raise', amount: 60 });
    expect(applyAction(s, 'p2', { type: 'raise', amount: 120 }).ok).toBe(false);
    act(s, 'p2', { type: 'allin' } as GameAction);
    expect(P(s, 'p2').contributed).toBe(60);
    expect(P(s, 'p2').allIn).toBe(false);
  });

  it('바꿔치기: 프리플랍에 상대와 홀카드 2장을 통째로 맞교환 (면역이면 무효, 방탄조끼면 막힘)', () => {
    const s = setup(3, { augs: { p1: ['switcheroo'] }, deal: D });
    use(s, 'p1', 'switcheroo', { targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p1').hole).toEqual(cards('Qc Jh'));
    expect(P(s, 'p2').hole).toEqual(cards('9c 8d'));

    const s2 = setup(3, { augs: { p1: ['switcheroo'], p2: ['immunity'] }, deal: D });
    use(s2, 'p1', 'switcheroo', { targetId: 'p2' });
    act(s2, 'p2', { type: 'immunity' });
    resolveAll(s2);
    expect(P(s2, 'p1').hole).toEqual(cards('9c 8d'));

    const s3 = setup(3, { augs: { p1: ['switcheroo'], p2: ['vest'] }, deal: D });
    use(s3, 'p1', 'switcheroo', { targetId: 'p2' });
    resolveAll(s3);
    expect(P(s3, 'p1').hole).toEqual(cards('9c 8d'));
    expect(P(s3, 'p2').augments[0].usesLeft).toBe(0);
  });

  it('시한폭탄: 플랍 직후 선언, 체크하면 폴드 (면역은 체크 가능)', () => {
    const s = setup(3, { augs: { p1: ['timeBomb'], p2: ['immunity'] }, deal: D });
    toWindow(s, 'flop');
    act(s, 'p1', { type: 'declare', augment: 'timeBomb' });
    act(s, 'p2', { type: 'immunity' });
    resolveAll(s);
    passUntil(s, () => s.phase === 'betting');
    act(s, 'p2', { type: 'check' });
    expect(P(s, 'p2').folded).toBe(false);
    act(s, 'p3', { type: 'check' });
    expect(P(s, 'p3').folded).toBe(true);
    expect(view(s, 'p1').table.timeBomb).toBe(true);
  });

  it('마지막 선택: 턴 베팅 뒤 각자 유지/1장 교체를 비공개로 고르고, 리버는 정상 공개', () => {
    const s = setup(3, { augs: { p1: ['lastChoice'] }, deal: D });
    toWindow(s, 'turnEnd');
    act(s, 'p1', { type: 'declare', augment: 'lastChoice' });
    resolveAll(s);
    expect(view(s, 'p1').respond!.input).toBe('cardOrKeep');
    respond(s, 'p1', { choice: 1, cardIndex: 0 });
    expect(view(s, 'p2').respond!.myAnswer).toBeNull();
    respond(s, 'p2', { choice: -1 });
    respond(s, 'p3', { choice: -1 });
    expect(P(s, 'p1').hole[0]).not.toBe('9c');
    expect(P(s, 'p1').hole[1]).toBe('8d');
    expect(s.used.some((u) => u.card === '9c' && u.kind === 'discard')).toBe(true);
    passUntil(s, () => s.street === 'river');
    expect(s.board[4]).toBe('2s');
  });
});

describe('4차 시뮬레이션 (봇끼리 완주, 칩 보존)', () => {
  const owned = (s: GameState) => s.players.flatMap((p) => p.augments.map((a) => a.id));

  it('증강 풀 1차만: 1차 증강만 나오고 끝까지 진행', () => {
    const pool = poolIds('p1');
    for (const seed of [11, 12]) {
      const seen = new Set<AugmentId>();
      const s = playGame(6, seed, { pool, handsPerLevel: 4 }, (st) => owned(st).forEach((id) => seen.add(id)));
      expect(s.phase).toBe('gameOver');
      for (const id of seen) expect(pool).toContain(id);
    }
  }, 300000);

  it('증강 풀 직접 고름(9개): 고른 증강만 나오고 끝까지 진행', () => {
    const by = (st: number) => ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].stars === st && AUGMENTS[id].pool === 4).slice(0, 3);
    const pool = poolIds('custom', [...by(1), ...by(2), ...by(3)]);
    expect(pool.length).toBe(9);
    const seen = new Set<AugmentId>();
    const s = playGame(5, 21, { pool, handsPerLevel: 3 }, (st) => owned(st).forEach((id) => seen.add(id)));
    expect(s.phase).toBe('gameOver');
    for (const id of seen) expect(pool).toContain(id);
  }, 300000);

  it('8인 전체 풀 + 4차 증강을 잔뜩 준 게임이 승자까지 간다', () => {
    for (const seed of [31, 32, 33]) {
      let given = false;
      const s = playGame(8, seed, { pool: poolIds('all'), handsPerLevel: 4, debug: true }, (st) => {
        if (given || st.phase !== 'betting') return;
        given = true;
        const rng = seededRng(seed);
        const pool4 = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].pool === 4);
        for (const p of st.players) {
          const mine: AugmentId[] = p.augments.map((a) => a.id);
          for (let k = 0; k < 10; k++) {
            const id = pool4[rng.int(pool4.length)];
            if (!canHold(mine, id)) continue;
            mine.push(id);
            ok(debugGiveAugment(st, p.id, id));
          }
        }
      });
      expect(s.phase).toBe('gameOver');
      expect(s.players.filter((p) => !p.out)).toHaveLength(1);
      expect(totalChips(s)).toBe(expectedChips(s, 8 * 1000));
    }
  }, 600000);
});
