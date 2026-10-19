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
  type AugmentId,
  type DebugDeal,
  type GameAction,
  type GameState,
} from '../src/index.js';
import { makePlayers } from './helpers.js';

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
