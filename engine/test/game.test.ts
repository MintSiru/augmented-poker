import { describe, expect, it } from 'vitest';
import {
  createGame,
  applyAction,
  applyTimeouts,
  getPending,
  startNextHand,
  debugGiveAugment,
  debugSetNextDeal,
  debugLevelUp,
  getPlayerView,
  legalActions,
  seededRng,
  rollAugmentOffer,
  canHold,
  cardsNeeded,
  AUGMENTS,
  ALL_AUGMENT_IDS,
  REACTION_MS,
  type AugmentId,
  type DebugDeal,
  type GameAction,
  type GameState,
} from '../src/index.js';
import { makePlayers, playGame, totalChips } from './helpers.js';

interface SetupOpts {
  dealer?: number;
  augs?: Record<string, AugmentId[]>;
  deal?: DebugDeal;
  chips?: number[];
  wild?: number;
  handsPerLevel?: number;
  seed?: number;
  before?: (s: GameState) => void;
}

function ok(r: { ok: boolean; error?: string }) {
  if (!r.ok) throw new Error(r.error);
}

/** 증강·칩·카드를 지정한 뒤 첫 핸드를 시작한다. 기본: p1 딜러 (3인: p2 SB, p3 BB, p1 먼저 / 2인: p1 SB 먼저) */
function setup(n: number, o: SetupOpts = {}): GameState {
  const state = createGame(
    makePlayers(n).map((p) => ({ ...p, isBot: false })),
    { rng: seededRng(o.seed ?? 42), debug: true, initialPick: false, dealerSeat: o.dealer ?? 0, handsPerLevel: o.handsPerLevel ?? 1000 },
  );
  for (const [id, list] of Object.entries(o.augs ?? {})) for (const a of list) ok(debugGiveAugment(state, id, a, o.wild));
  o.chips?.forEach((c, i) => (state.players[i].chips = c));
  if (o.deal) ok(debugSetNextDeal(state, o.deal));
  o.before?.(state);
  ok(startNextHand(state));
  resolveAll(state);
  return state;
}

const act = (s: GameState, id: string, a: GameAction) => ok(applyAction(s, id, a));
const use = (s: GameState, id: string, augment: AugmentId, extra: Record<string, unknown> = {}) =>
  act(s, id, { type: 'useAugment', augment, ...extra } as GameAction);
const P = (s: GameState, id: string) => s.players.find((p) => p.id === id)!;
const toAct = (s: GameState) => getPending(s).playerIds[0];
const cards = (x: string) => x.split(' ');
const view = (s: GameState, id: string) => getPlayerView(s, id);

/** 반응 대기(3초)를 모두 끝낸다 */
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

describe('보유 규칙과 선택지', () => {
  it('4장 플러시와 징검다리는 둘 중 하나, 방어/카운터형은 1개만', () => {
    expect(canHold(['fourFlush'], 'gapStraight')).toBe(false);
    expect(canHold(['gapStraight'], 'fourFlush')).toBe(false);
    expect(canHold(['vest'], 'mirror')).toBe(false);
    expect(canHold(['counterSpell'], 'disinfo')).toBe(false);
    expect(canHold(['vest'], 'fourFlush')).toBe(true);
    expect(canHold(['observer'], 'observer')).toBe(false);
  });

  it('보유할 수 없는 증강은 선택지에 나오지 않는다', () => {
    const rng = seededRng(5);
    for (let i = 0; i < 400; i++) {
      const owned: AugmentId[] = ['fourFlush', 'mirror'];
      const offer = rollAugmentOffer(1 + (i % 6), owned, rng);
      expect(offer.length).toBe(3);
      expect(offer.every((id) => canHold(owned, id))).toBe(true);
      expect(offer).not.toContain('gapStraight');
      expect(offer.some((id) => AUGMENTS[id].group === 'counter')).toBe(false);
    }
  });

  it('같은 별에서 3개 미만이면 한 단계 낮은 별에서 채운다', () => {
    const owned: AugmentId[] = ['foresight', 'seal', 'favoritism', 'enforcement', 'counterSpell'];
    const offer = rollAugmentOffer(5, owned, seededRng(1), 3);
    expect(offer).toHaveLength(3);
    expect(offer.filter((id) => AUGMENTS[id].stars === 3).sort()).toEqual(['flipTable', 'heavyFog']);
    expect(offer.filter((id) => AUGMENTS[id].stars === 2)).toHaveLength(1);
    // 같은 별이 충분하면 3개 모두 같은 별
    const rng = seededRng(2);
    for (let i = 0; i < 200; i++) {
      const o = rollAugmentOffer(3, [], rng);
      expect(new Set(o.map((id) => AUGMENTS[id].stars)).size).toBe(1);
    }
  });

  it('별 개수 확률이 레벨 표를 따른다', () => {
    const rng = seededRng(11);
    const count = (level: number) => {
      const c = [0, 0, 0];
      for (let i = 0; i < 20000; i++) c[AUGMENTS[rollAugmentOffer(level, [], rng)[0]].stars - 1]++;
      return c.map((x) => x / 200);
    };
    const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(1.5));
    close(count(1), [70, 25, 5]);
    close(count(2), [55, 35, 10]);
    close(count(3), [40, 45, 15]);
    close(count(4), [30, 47.5, 22.5]);
    close(count(5), [20, 50, 30]);
  });

  it('1차 풀 35개 + 죽음과 세금이 모두 정의되어 있다', () => {
    expect(ALL_AUGMENT_IDS).toHaveLength(36);
    const byStars = [1, 2, 3].map((s) => ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].stars === s).length);
    expect(byStars).toEqual([13, 16, 7]);
  });
});

describe('블라인드·행동 순서·베팅 검증', () => {
  it('3인: SB/BB 위치와 행동 순서', () => {
    const s = setup(3);
    expect(P(s, 'p2').streetBet).toBe(10);
    expect(P(s, 'p3').streetBet).toBe(20);
    expect(toAct(s)).toBe('p1');
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'check' });
    expect(s.street).toBe('flop');
    expect(toAct(s)).toBe('p2');
  });

  it('헤즈업: 딜러가 SB를 내고 프리플랍 먼저, 플랍부터는 BB 먼저', () => {
    const s = setup(2);
    expect(P(s, 'p1').streetBet).toBe(10);
    expect(toAct(s)).toBe('p1');
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'check' });
    expect(toAct(s)).toBe('p2');
  });

  it('최소 레이즈와 불완전 올인', () => {
    const s = setup(3, { chips: [1000, 1000, 150] });
    expect(applyAction(s, 'p1', { type: 'raise', amount: 30 }).ok).toBe(false);
    act(s, 'p1', { type: 'raise', amount: 100 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'allin' });
    expect(legalActions(s, 'p1')!.raise).toBe(false);
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    expect(s.street).toBe('flop');
  });

  it('번 카드: 플랍·턴·리버 앞에 1장씩 사용된 카드로 기록', () => {
    const s = setup(2);
    passUntil(s, () => s.street === 'river');
    expect(s.used.filter((u) => u.kind === 'burn').map((u) => u.card)).toEqual(s.burns);
    const all = [...s.board, ...s.burns, ...s.players.flatMap((p) => p.hole), ...s.deck];
    expect(new Set(all).size).toBe(52);
  });

  it('시간 초과: 체크 가능하면 체크, 아니면 폴드', () => {
    const s = setup(3);
    applyTimeouts(s);
    expect(P(s, 'p1').folded).toBe(true);
  });
});

describe('사이드팟과 쇼다운', () => {
  it('세 명이 서로 다른 금액으로 올인', () => {
    const s = setup(3, {
      chips: [100, 300, 500],
      deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('As Ad'), p2: cards('Ks Kd'), p3: cards('Qs Qd') } },
    });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'allin' });
    act(s, 'p3', { type: 'call' });
    expect(s.phase).toBe('handEnd');
    expect(s.result!.pots.map((p) => [p.amount, p.winners])).toEqual([
      [300, ['p1']],
      [400, ['p2']],
    ]);
    expect([P(s, 'p1').chips, P(s, 'p2').chips, P(s, 'p3').chips]).toEqual([300, 400, 200]);
  });

  it('칩이 0이 되면 탈락하고 마지막 1인이 우승', () => {
    const s = setup(2, { deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('As Ad'), p2: cards('Ks Kd') } } });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'call' });
    expect(s.phase).toBe('gameOver');
    expect(s.winnerId).toBe('p1');
  });
});

describe('반응 대기와 카운터 스펠', () => {
  it('액티브 증강은 3초 반응 대기 뒤에 적용되고, 그동안 다른 행동은 막힌다', () => {
    const s = setup(3, { augs: { p1: ['mulligan'] }, deal: { hands: { p1: cards('2c 7d') } } });
    use(s, 'p1', 'mulligan', { cardIndex: 0 });
    expect(s.phase).toBe('reaction');
    expect(getPending(s)).toMatchObject({ kind: 'reaction', playerIds: [] });
    expect(REACTION_MS).toBe(3000);
    expect(P(s, 'p1').hole[0]).toBe('2c'); // 아직 적용 전
    expect(applyAction(s, 'p1', { type: 'call' }).ok).toBe(false);
    applyTimeouts(s);
    expect(s.phase).toBe('betting');
    expect(P(s, 'p1').hole[0]).not.toBe('2c');
    expect(P(s, 'p1').chips).toBe(980);
    expect(toAct(s)).toBe('p1');
  });

  it('카운터 스펠: 효과를 무효화하고 상대의 사용 횟수는 소모된다', () => {
    const s = setup(3, { augs: { p1: ['mulligan'], p2: ['counterSpell'] }, deal: { hands: { p1: cards('2c 7d') } } });
    use(s, 'p1', 'mulligan', { cardIndex: 0 });
    expect(view(s, 'p2').reaction!.canCounter).toBe(true);
    expect(view(s, 'p3').reaction!.canCounter).toBe(false);
    expect(applyAction(s, 'p3', { type: 'counter' }).ok).toBe(false); // 보유하지 않음
    act(s, 'p2', { type: 'counter' });
    expect(applyAction(s, 'p2', { type: 'counter' }).ok).toBe(false);
    expect(s.phase).toBe('reaction'); // 대기 시간은 그대로
    applyTimeouts(s);
    expect(P(s, 'p1').hole[0]).toBe('2c');
    expect(P(s, 'p1').chips).toBe(1000);
    expect(P(s, 'p1').augments[0].usedThisHand).toBe(true);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
    expect(view(s, 'p3').log.some((e) => e.text.includes('무효화'))).toBe(true);
  });

  it('자기 증강은 무효화할 수 없다', () => {
    const s = setup(3, { augs: { p1: ['glassTable', 'counterSpell'] } });
    use(s, 'p1', 'glassTable');
    expect(applyAction(s, 'p1', { type: 'counter' }).ok).toBe(false);
  });

  it('겹쳐 선언하면 선언 순서대로 각각 3초 대기 후 적용', () => {
    const s = setup(3, { augs: { p1: ['glassTable'], p2: ['russianRoulette'] } });
    use(s, 'p1', 'glassTable');
    use(s, 'p2', 'russianRoulette');
    expect(s.reaction!.queue).toHaveLength(2);
    applyTimeouts(s);
    expect(s.effects.glass).toBe(true);
    expect(s.phase).toBe('reaction');
    applyTimeouts(s);
    expect(s.players.filter((p) => p.folded)).toHaveLength(1);
    expect(totalChips(s)).toBe(3000);
  });
});

describe('정보형', () => {
  it('열화상 카메라: 하이/로우 개수만 나만 확인 (이름 없는 알림)', () => {
    const s = setup(3, { augs: { p1: ['thermal'] }, deal: { hands: { p2: cards('Kd 4c') } } });
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    expect(view(s, 'p3').log.at(-1)!.text).toBe('P1님이 비공개 증강을 사용했습니다');
    expect(view(s, 'p3').reaction!.label).toBe('비공개 증강');
    resolveAll(s);
    expect(P(s, 'p1').notes.at(-1)!.text).toContain('하이 1장, 로우 1장');
    expect(P(s, 'p1').augments[0].usesLeft).toBe(2);
    expect(P(s, 'p1').augments[0].revealed).toBe(false);
  });

  it('투시: 상대 홀카드 중 1장', () => {
    const s = setup(3, { augs: { p1: ['clairvoyance'] } });
    use(s, 'p1', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    const n = P(s, 'p1').notes.find((x) => x.kind === 'clairvoyance')!;
    expect(P(s, 'p2').hole).toContain(n.cards![0]);
    expect(JSON.stringify(view(s, 'p3'))).not.toContain(n.text);
  });

  it('거짓말 탐지기: 상대가 베팅·레이즈한 직후에만, 메이드 여부만', () => {
    const s = setup(3, {
      augs: { p1: ['liedetector'] },
      deal: { board: cards('Kh 7c 2d 9s 4h'), hands: { p2: cards('Kd Qs'), p3: cards('8s 8c') } },
    });
    passUntil(s, () => s.street === 'flop');
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'liedetector', targetId: 'p2' }).ok).toBe(false);
    act(s, 'p2', { type: 'raise', amount: 40 });
    expect(view(s, 'p1').lastAggressorId).toBe('p2');
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'liedetector', targetId: 'p3' }).ok).toBe(false);
    use(s, 'p1', 'liedetector', { targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p1').notes.at(-1)!.text).toContain('메이드 핸드입니다');
    act(s, 'p3', { type: 'call' });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'liedetector', targetId: 'p2' }).ok).toBe(false);
  });

  it('카운팅: 번 카드·폴드한 카드를 실시간으로 보고, 아웃츠와 완성 확률을 계산', () => {
    const s = setup(3, {
      augs: { p1: ['counting'] },
      deal: { board: cards('Qh 7h 2c 9s 4d'), hands: { p1: cards('Ah Kh'), p2: cards('3s 3d') } },
    });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'fold' });
    act(s, 'p3', { type: 'check' });
    const c = view(s, 'p1').you.counting!;
    expect(c.used.map((u) => u.kind).sort()).toEqual(['burn', 'fold', 'fold']);
    expect(c.used.filter((u) => u.kind === 'fold').map((u) => u.card).sort()).toEqual(['3d', '3s']);
    expect(c.unseen).toHaveLength(52 - 2 - 3 - 1 - 2);
    const hearts = c.unseen.filter((x) => x[1] === 'h');
    for (const h of hearts) expect(c.outCards).toContain(h);
    expect(c.completion).toBeGreaterThan(0.3);
    expect(c.completion).toBeLessThan(1);
    // 카운팅이 없는 사람은 폴드한 카드를 모른다
    expect(view(s, 'p3').you.counting).toBeNull();
    expect(JSON.stringify(view(s, 'p3'))).not.toMatch(/\b3s\b|\b3d\b/);
  });

  it('예지: 다음 보드 카드를 미리 보고 그대로 나오지만, 되감기가 쓰이면 바뀐다', () => {
    const s = setup(2, { augs: { p1: ['foresight'], p2: ['rewind'] } });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'foresight' }).ok).toBe(false);
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'foresight');
    resolveAll(s);
    const seen = P(s, 'p1').notes.find((n) => n.kind === 'foresight')!.cards![0];
    passUntil(s, () => s.street === 'turn');
    expect(s.board[3]).toBe(seen);
    expect(s.phase).toBe('declare');
    act(s, 'p2', { type: 'declare', augment: 'rewind' });
    resolveAll(s);
    expect(s.board[3]).not.toBe(seen);
    expect(s.used.some((u) => u.kind === 'rewind' && u.card === seen)).toBe(true);
    expect(s.effects.rewinds).toBe(1);
  });

  it('관찰자: 폴드한 상대 카드를 나만 보고, 공개되지 않는다', () => {
    const s = setup(3, { augs: { p3: ['observer'] } });
    const p1Hole = [...P(s, 'p1').hole];
    act(s, 'p1', { type: 'fold' });
    act(s, 'p2', { type: 'fold' });
    expect(P(s, 'p3').notes.filter((n) => n.kind === 'observer')[0].cards).toEqual(p1Hole);
    expect(P(s, 'p3').augments[0].revealed).toBe(false);
    for (const c of p1Hole) expect(JSON.stringify(view(s, 'p2'))).not.toContain(c);
  });
});

describe('카드 조작형', () => {
  it('세 번째 손: 동시에 결정 후 한 번에 처리', () => {
    const s = setup(3, { augs: { p1: ['thirdHand'], p2: ['thirdHand'] } });
    expect(P(s, 'p1').hole).toHaveLength(3);
    passUntil(s, () => s.street === 'flop');
    expect(s.phase).toBe('discard');
    act(s, 'p1', { type: 'discard', cardIndex: 0 });
    expect(P(s, 'p1').hole).toHaveLength(3);
    act(s, 'p2', { type: 'discard', cardIndex: 2 });
    expect(P(s, 'p1').hole).toHaveLength(2);
    expect(s.used.filter((u) => u.kind === 'discard')).toHaveLength(2);
  });

  it('애착: 쇼다운에서 이기면 1장을 다음 핸드로 가져가고 덱에서 빠진다', () => {
    const s = setup(2, { augs: { p1: ['attachment'] }, deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('As Ad'), p2: cards('Ks Kd') } } });
    passUntil(s, () => s.phase === 'handEnd');
    expect(view(s, 'p1').you.attach!.cards).toEqual(['As', 'Ad']);
    act(s, 'p1', { type: 'attach', cardIndex: 0 });
    ok(startNextHand(s));
    resolveAll(s);
    expect(P(s, 'p1').hole).toContain('As');
    const all = [...s.board, ...s.burns, ...s.players.flatMap((p) => p.hole), ...s.deck];
    expect(new Set(all).size).toBe(52);
  });

  it('봉인: 리버 공개 직후, 리버 베팅 전 선언 기회에', () => {
    const s = setup(2, { augs: { p1: ['seal'] }, deal: { board: cards('Ah Kd 7c 3s 2h'), hands: { p1: cards('Kc Qd'), p2: cards('Ac 5s') } } });
    passUntil(s, () => s.street === 'river');
    expect(s.phase).toBe('declare');
    expect(view(s, 'p1').you.declare!.options.map((o) => o.id)).toEqual(['seal']);
    expect(view(s, 'p2').waiting).toMatchObject({ kind: 'declare', playerId: null });
    act(s, 'p1', { type: 'declare', augment: 'seal', boardIndex: 0 });
    resolveAll(s);
    expect(s.phase).toBe('betting');
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
    expect(s.result!.table.some((t) => t.includes('봉인'))).toBe(true);
  });

  it('덱 관리: 8인 전원이 세 번째 손·멀리건·되감기를 가져도 충분하다', () => {
    const augs = Object.fromEntries(makePlayers(8).map((p) => [p.id, ['thirdHand', 'mulligan', 'rewind'] as AugmentId[]]));
    const s = setup(8, { augs });
    expect(cardsNeeded(s)).toBe(5 + 3 + 24 + 8 + 8);
    expect(cardsNeeded(s)).toBeLessThanOrEqual(52);
  });
});

describe('족보 변형형과 동점 처리', () => {
  it('키커 장인: 완전 동점이면 보유자가 이긴다', () => {
    const s = setup(2, { augs: { p1: ['kickerMaster'] }, deal: { board: cards('As Kd 9c 7h 2s'), hands: { p1: cards('Qd Js'), p2: cards('Qc Jh') } } });
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
    expect(s.result!.entries.find((e) => e.id === 'p1')!.tiebreak).toEqual(['kickerMaster']);
    expect(P(s, 'p1').augments[0].revealed).toBe(true);
  });

  it('절대 키커: 같은 숫자의 같은 족보면 키커와 상관없이 이긴다', () => {
    const s = setup(2, { augs: { p1: ['absoluteKicker'] }, deal: { board: cards('Kh 8d 5c 3s 2h'), hands: { p1: cards('Ks 4d'), p2: cards('Kc Qh') } } });
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
  });

  it('절대 키커: 보드 5장만으로 만든 완전 동점은 스플릿', () => {
    const s = setup(2, { augs: { p1: ['absoluteKicker'] }, deal: { board: cards('As Ks Qs Js Ts'), hands: { p1: cards('2c 3d'), p2: cards('4h 5h') } } });
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners.sort()).toEqual(['p1', 'p2']);
  });

  it('원형 스트레이트로 이긴다 (결과에 변형 족보 이름)', () => {
    const s = setup(2, { augs: { p1: ['wrapStraight'] }, deal: { board: cards('Qd Kc 2h 9s 6d'), hands: { p1: cards('Ah 3c'), p2: cards('9c 9d') } } });
    passUntil(s, () => s.phase === 'handEnd');
    const e = s.result!.entries.find((x) => x.id === 'p1')!;
    expect(e.handName).toBe('원형 스트레이트 (3 하이)');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
    expect(view(s, 'p2').result!.entries.find((x) => x.id === 'p1')!.variants).toEqual(['원형 스트레이트']);
  });

  it('편애 와일드로 이긴다', () => {
    const s = setup(2, {
      augs: { p1: ['favoritism'] },
      wild: 7,
      deal: { board: cards('As Ad Kc 2h 9s'), hands: { p1: cards('7c 7d'), p2: cards('Ks Kh') } },
    });
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.entries.find((x) => x.id === 'p1')!.handName).toBe('포카드 (A)');
    expect(view(s, 'p2').result!.entries.find((x) => x.id === 'p1')!.variants).toEqual(['와일드카드 사용']);
  });
});

describe('밥상 뒤집기 (족보 역전)', () => {
  const deal = { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('3s 5d'), p2: cards('As Ad') } };

  it('역전되면 가장 낮은 패가 이긴다', () => {
    const s = setup(2, { augs: { p1: ['flipTable'] }, deal });
    passUntil(s, () => s.street === 'river');
    act(s, 'p1', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
    expect(s.result!.table[0]).toContain('족보 역전');
  });

  it('두 번 겹치면 상쇄되어 원래 순위', () => {
    const s = setup(2, { augs: { p1: ['flipTable'], p2: ['flipTable'] }, deal });
    passUntil(s, () => s.street === 'river');
    // 딜러 왼쪽(p2)부터 선언 기회
    act(s, 'p2', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    act(s, 'p1', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.effects.flips).toBe(2);
    expect(s.result!.pots[0].winners).toEqual(['p2']);
  });

  it('역전 중에도 변형 증강을 먼저 적용한 뒤 뒤집는다', () => {
    const s = setup(2, {
      augs: { p1: ['flipTable', 'fourFlush'] },
      deal: { board: cards('Kh 2h Qs Jc 5d'), hands: { p1: cards('Ah 9h'), p2: cards('Kc Kd') } },
    });
    passUntil(s, () => s.street === 'river');
    act(s, 'p1', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    passUntil(s, () => s.phase === 'handEnd');
    // p1 은 4장 플러시(높은 족보)가 되어 역전에서 진다
    expect(s.result!.entries.find((e) => e.id === 'p1')!.handName).toContain('4장 플러시');
    expect(s.result!.pots[0].winners).toEqual(['p2']);
  });

  it('역전 중에도 동점 처리 증강은 보유자가 이긴다', () => {
    const s = setup(2, {
      augs: { p1: ['flipTable', 'kickerMaster'] },
      deal: { board: cards('As Kd 9c 7h 2s'), hands: { p1: cards('Qd Js'), p2: cards('Qc Jh') } },
    });
    passUntil(s, () => s.street === 'river');
    act(s, 'p1', { type: 'declare', augment: 'flipTable' });
    resolveAll(s);
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.pots[0].winners).toEqual(['p1']);
  });
});

describe('경제/베팅형', () => {
  it('보험: 플랍 이후 폴드하면 낸 칩의 25%를 팟에서', () => {
    const s = setup(3, { augs: { p2: ['insurance'] } });
    act(s, 'p1', { type: 'call' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'check' });
    act(s, 'p2', { type: 'raise', amount: 40 });
    act(s, 'p3', { type: 'raise', amount: 120 });
    act(s, 'p1', { type: 'fold' });
    act(s, 'p2', { type: 'fold' });
    expect(P(s, 'p2').chips).toBe(1000 - 60 + 15);
    expect(totalChips(s)).toBe(3000);
  });

  it('면제권: 블라인드 차례에 선언되고 반응 대기 후 블라인드를 내지 않는다', () => {
    const s = setup(3, { augs: { p2: ['exemption'] }, before: (st) => use(st, 'p2', 'exemption', { on: true }) });
    expect(P(s, 'p2').streetBet).toBe(0);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(2);
    expect(view(s, 'p1').players[1].revealedAugments[0].name).toBe('면제권');
  });

  it('면제권이 카운터되면 블라인드를 낸다', () => {
    const s = createGame(makePlayers(3), { rng: seededRng(3), debug: true, initialPick: false, dealerSeat: 0 });
    ok(debugGiveAugment(s, 'p2', 'exemption'));
    ok(debugGiveAugment(s, 'p3', 'counterSpell'));
    use(s, 'p2', 'exemption', { on: true });
    ok(startNextHand(s));
    expect(s.phase).toBe('reaction');
    act(s, 'p3', { type: 'counter' });
    resolveAll(s);
    expect(P(s, 'p2').streetBet).toBe(10);
  });

  it('하이리스크: 올인 승리 시 팟의 20%를 은행에서', () => {
    const s = setup(3, { augs: { p1: ['highRisk'] }, deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('As Ad'), p2: cards('Ks Kd') } } });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    expect(P(s, 'p1').chips).toBe(2020 + 404);
    expect(s.stats.bankChips).toBe(404);
  });

  it('하이리스크: 올인 패배 시 다음 증강 선택 1번 상실', () => {
    const s = setup(3, {
      augs: { p1: ['highRisk'] },
      chips: [1000, 500, 1000],
      handsPerLevel: 1,
      deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('Ks Kd'), p2: cards('As Ad') } },
    });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'fold' });
    expect(P(s, 'p1').skipPicks).toBe(1);
    ok(startNextHand(s));
    expect(P(s, 'p1').pickOptions).toBeNull();
    expect(P(s, 'p2').pickOptions).not.toBeNull();
  });

  it('무임승차: 레이즈에 콜할 때 절반만 내고, 초과분은 상대에게 돌아간다', () => {
    const s = setup(2, { augs: { p2: ['freeRide'] } });
    act(s, 'p1', { type: 'raise', amount: 200 });
    const l = legalActions(s, 'p2')!;
    expect(l.freeRide).toBe(true);
    expect(l.freeRideAmount).toBe(90);
    act(s, 'p2', { type: 'call', freeRide: true });
    resolveAll(s);
    expect(s.street).toBe('flop');
    expect(P(s, 'p1').chips).toBe(890);
    expect(P(s, 'p2').chips).toBe(890);
    expect(view(s, 'p1').pot).toBe(220);
  });

  it('무임승차: 블라인드만 마주했을 때는 쓸 수 없다', () => {
    const s = setup(2, { augs: { p1: ['freeRide'] } });
    expect(legalActions(s, 'p1')!.freeRide).toBe(false);
    expect(applyAction(s, 'p1', { type: 'call', freeRide: true }).ok).toBe(false);
  });

  it('강제 집행: 리버에서 올인한 뒤 지목한 상대는 폴드할 수 없다', () => {
    const s = setup(2, { augs: { p1: ['enforcement'] }, chips: [300, 1000] });
    passUntil(s, () => s.street === 'river' && s.phase === 'betting');
    act(s, 'p2', { type: 'check' });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'enforcement', targetId: 'p2' }).ok).toBe(false); // 아직 올인 전
    act(s, 'p1', { type: 'allin' });
    use(s, 'p1', 'enforcement', { targetId: 'p2' });
    resolveAll(s);
    expect(legalActions(s, 'p2')!.fold).toBe(false);
    expect(applyAction(s, 'p2', { type: 'fold' }).ok).toBe(false);
    applyTimeouts(s); // 시간 초과 → 콜
    expect(s.phase === 'handEnd' || s.phase === 'gameOver').toBe(true);
    expect(s.result!.showdown).toBe(true);
  });
});

describe('심리전형', () => {
  it('위장: 다음에 이름이 공개되는 증강이 가짜 이름으로 보인다', () => {
    const s = setup(3, { augs: { p1: ['disguise', 'mulligan'] } });
    use(s, 'p1', 'disguise', { fakeId: 'insurance' });
    use(s, 'p1', 'mulligan', { cardIndex: 0 });
    expect(view(s, 'p2').reaction!.label).toBe('보험');
    resolveAll(s);
    expect(view(s, 'p2').players[0].revealedAugments.map((a) => a.name)).toEqual(['보험']);
    const other = JSON.stringify(view(s, 'p2'));
    expect(other).not.toContain('멀리건');
    expect(other).not.toContain('위장');
    expect(view(s, 'p1').you.augments.find((a) => a.id === 'mulligan')!.publicName).toBe('보험');
  });

  it('탐문: 별 개수만', () => {
    const s = setup(3, { augs: { p1: ['inquiry'], p2: ['observer', 'seal', 'clairvoyance'] } });
    use(s, 'p1', 'inquiry', { targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p1').notes.at(-1)!.text).toContain('★★★, ★★, ★');
  });

  it('공포탄: 다른 액티브 증강이 있어야 하고, 알림은 진짜와 같고 효과는 없다', () => {
    const s = setup(3, { augs: { p1: ['blank'], p2: ['blank', 'clairvoyance'] } });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'blank' }).ok).toBe(false);
    const before = JSON.stringify(s.players.map((p) => [p.chips, p.hole]));
    use(s, 'p2', 'blank');
    expect(view(s, 'p3').log.at(-1)!.text).toBe('P2님이 비공개 증강을 사용했습니다');
    expect(view(s, 'p3').reaction!.label).toBe('비공개 증강');
    resolveAll(s);
    expect(JSON.stringify(s.players.map((p) => [p.chips, p.hole]))).toBe(before);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(1);
  });

  it('양치기 소년: 진짜 공개는 모두에게 그 카드가 보인다', () => {
    const s = setup(3, { augs: { p1: ['shepherd'] }, deal: { hands: { p1: cards('As Kd') } } });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'shepherd', cardIndex: 0 }).ok).toBe(false); // 프리플랍 불가
    passUntil(s, () => s.street === 'flop');
    use(s, 'p1', 'shepherd', { cardIndex: 0 });
    resolveAll(s);
    expect(view(s, 'p2').players[0].shepherdShown).toEqual(['As']);
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'shepherd', cardIndex: 1 }).ok).toBe(false); // 핸드당 1회
  });

  it('양치기 소년: 가짜 공개는 구별되지 않고, 쇼다운에서 들키면 2BB를 나눠 준다', () => {
    const s = setup(2, { augs: { p1: ['shepherd'] }, deal: { board: cards('2c 7d 9h Js 4c'), hands: { p1: cards('3s 5d'), p2: cards('8s 8c') } } });
    passUntil(s, () => s.street === 'flop');
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'shepherd', card: '2c' }).ok).toBe(false); // 보드와 겹침
    use(s, 'p1', 'shepherd', { card: 'Ah' });
    resolveAll(s);
    const otherView = view(s, 'p2');
    expect(otherView.players[0].shepherdShown).toEqual(['Ah']);
    // 진짜 공개와 같은 문장, 가짜라는 표시는 본인에게만
    expect(otherView.log.some((e) => e.text === 'P1: 홀카드 [Ah] 공개')).toBe(true);
    expect(otherView.log.some((e) => e.text.includes('가짜 카드를 공개'))).toBe(false);
    expect(view(s, 'p1').log.some((e) => e.text.includes('가짜 카드를 공개'))).toBe(true);
    passUntil(s, () => s.phase === 'handEnd');
    expect(s.result!.extras.some((x) => x.includes('거짓 공개') && x.includes('40'))).toBe(true);
    // p2 는 팟(40) + 벌금(40)
    expect(P(s, 'p2').chips).toBe(1020 + 40);
  });
});

describe('방어/카운터형', () => {
  it('역정보: 처음 노출될 때 가짜 결과, 그다음은 진짜', () => {
    const s = setup(3, { augs: { p1: ['clairvoyance'], p2: ['disinfo'], p3: ['clairvoyance'] } });
    use(s, 'p1', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    const fake = P(s, 'p1').notes.at(-1)!.cards![0];
    expect(P(s, 'p2').hole).not.toContain(fake);
    expect(P(s, 'p2').augments[0].usesLeft).toBe(0);
    use(s, 'p3', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p2').hole).toContain(P(s, 'p3').notes.at(-1)!.cards![0]);
  });

  it('역정보: 열화상·거짓말 탐지기 결과도 실제와 다르게', () => {
    const s = setup(2, { augs: { p1: ['thermal'], p2: ['disinfo'] }, deal: { hands: { p2: cards('Kd Qc') } } });
    use(s, 'p1', 'thermal', { targetId: 'p2' });
    resolveAll(s);
    expect(P(s, 'p1').notes.at(-1)!.text).not.toContain('하이 2장');
  });

  it('방탄조끼: 러시안 룰렛의 강제 폴드를 막는다', () => {
    const s = setup(3, { augs: { p1: ['russianRoulette', 'vest'], p2: ['vest'], p3: ['vest'] } });
    use(s, 'p1', 'russianRoulette');
    resolveAll(s);
    expect(s.players.filter((p) => p.folded)).toHaveLength(0);
    expect(s.players.filter((p) => p.augments.some((a) => a.id === 'vest' && a.usesLeft === 0))).toHaveLength(1);
  });

  it('거울: 내 정보를 본 사람의 같은 종류 정보를 나도 본다', () => {
    const s = setup(2, { augs: { p1: ['clairvoyance'], p2: ['mirror'] } });
    use(s, 'p1', 'clairvoyance', { targetId: 'p2' });
    resolveAll(s);
    const m = P(s, 'p2').notes.find((n) => n.kind === 'mirror')!;
    expect(m.text).toContain('P1');
    expect(P(s, 'p1').hole).toContain(m.cards![0]);
    expect(P(s, 'p2').augments[0].revealed).toBe(false);
  });
});

describe('공개형', () => {
  it('암전: 카드를 나눠 주기 전에 선언하면 모두 자기 카드를 못 본 채 진행', () => {
    const s = setup(3, {
      augs: { p1: ['blackout'], p2: ['mulligan', 'thirdHand'] },
      before: (st) => {
        use(st, 'p1', 'blackout');
        resolveAll(st);
      },
    });
    expect(s.effects.blackout).toBe(true);
    for (const id of ['p1', 'p2', 'p3']) {
      const v = view(s, id);
      expect(v.you.hole).toEqual([]);
      expect(v.you.holeHidden).toBeGreaterThan(0);
      for (const c of P(s, id).hole) expect(JSON.stringify(v)).not.toContain(`"${c}"`);
    }
    // 멀리건은 무작위 1장, 세 번째 손은 무작위로 버림 (선택 단계 없음)
    use(s, 'p2', 'mulligan');
    resolveAll(s);
    expect(P(s, 'p2').discarded).toHaveLength(1);
    passUntil(s, () => s.street === 'flop');
    expect(s.phase).not.toBe('discard');
    expect(P(s, 'p2').hole).toHaveLength(2);
    passUntil(s, () => s.phase === 'handEnd');
    expect(view(s, 'p1').you.hole).toHaveLength(2); // 쇼다운에서 공개
  });

  it('암전은 핸드 중에는 선언할 수 없다', () => {
    const s = setup(3, { augs: { p1: ['blackout'] } });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'blackout' }).ok).toBe(false);
  });

  it('유리 테이블: 모든 홀카드를 공개한 채 진행 (암전보다 나중에 선언되면 우선)', () => {
    const s = setup(3, {
      augs: { p1: ['blackout'], p2: ['glassTable'] },
      before: (st) => {
        use(st, 'p1', 'blackout');
        resolveAll(st);
      },
    });
    use(s, 'p2', 'glassTable');
    resolveAll(s);
    expect(view(s, 'p1').you.hole).toEqual(P(s, 'p1').hole);
    expect(view(s, 'p1').players[2].shownCards).toEqual(P(s, 'p3').hole);
  });

  it('러시안 룰렛: 3명 이상일 때만, 무작위 1명 강제 폴드 (칩은 팟에)', () => {
    const s = setup(3, { augs: { p1: ['russianRoulette'] } });
    act(s, 'p1', { type: 'fold' });
    expect(applyAction(s, 'p1', { type: 'useAugment', augment: 'russianRoulette' }).ok).toBe(false);
    const t = setup(4, { augs: { p1: ['russianRoulette'] } });
    use(t, 'p1', 'russianRoulette');
    resolveAll(t);
    const victim = t.players.find((p) => p.folded)!;
    expect(victim.lastAction).toBe('강제 폴드');
    expect(totalChips(t)).toBe(4000);
  });

  it('짙은 안개: 플랍은 선언자만 보고, 쇼다운 때 모두에게 공개', () => {
    const s = setup(3, { augs: { p1: ['heavyFog'] }, deal: { board: cards('Ah Kd 7c 3s 2h') } });
    use(s, 'p1', 'heavyFog');
    resolveAll(s);
    passUntil(s, () => s.street === 'flop');
    expect(view(s, 'p1').board).toEqual(['Ah', 'Kd', '7c']);
    expect(view(s, 'p2').board).toEqual([null, null, null]);
    const v2 = JSON.stringify(view(s, 'p2'));
    for (const c of ['Ah', 'Kd', '7c']) expect(v2).not.toContain(c);
    passUntil(s, () => s.phase === 'handEnd');
    expect(view(s, 'p2').result!.board.slice(0, 3)).toEqual(['Ah', 'Kd', '7c']);
  });

  it('죽음과 세금: 선언자 외에는 액티브 증강을 쓸 때마다 1BB, 두 명이면 2BB, 자기 몫은 면제', () => {
    const s = setup(3, { augs: { p1: ['deathTax', 'inquiry'], p2: ['blank', 'inquiry'], p3: ['deathTax', 'inquiry'] } });
    use(s, 'p1', 'deathTax');
    resolveAll(s);
    const chips = (id: string) => P(s, id).chips;
    let c = chips('p2');
    use(s, 'p2', 'inquiry', { targetId: 'p1' });
    resolveAll(s);
    expect(chips('p2')).toBe(c - 20);
    c = chips('p1');
    use(s, 'p1', 'inquiry', { targetId: 'p2' });
    resolveAll(s);
    expect(chips('p1')).toBe(c); // 선언자는 면제
    c = chips('p3');
    use(s, 'p3', 'deathTax');
    resolveAll(s);
    expect(chips('p3')).toBe(c - 20);
    c = chips('p2');
    use(s, 'p2', 'blank'); // 공포탄도 납부
    resolveAll(s);
    expect(chips('p2')).toBe(c - 40);
    c = chips('p1');
    use(s, 'p1', 'inquiry', { targetId: 'p3' });
    resolveAll(s);
    expect(chips('p1')).toBe(c - 20); // p3 몫만
    expect(view(s, 'p2').you.tax).toBe(40);
    expect(s.stats.bankTaxed).toBe(100);
    // 낼 칩이 없으면 못 쓴다
    P(s, 'p2').chips = 30;
    expect(applyAction(s, 'p2', { type: 'useAugment', augment: 'inquiry', targetId: 'p1' }).ok).toBe(false);
  });
});

describe('통계와 디버그', () => {
  it('선택·사용 횟수와 은행 칩을 기록하고, 디버그로 블라인드 레벨을 즉시 올린다', () => {
    const s = setup(3, { augs: { p1: ['inquiry'] } });
    use(s, 'p1', 'inquiry', { targetId: 'p2' });
    resolveAll(s);
    expect(s.stats.picks.inquiry).toBe(1);
    expect(s.stats.uses.inquiry).toBe(1);
    ok(debugLevelUp(s));
    passUntil(s, () => s.phase === 'handEnd');
    ok(startNextHand(s));
    expect(s.levelIndex).toBe(1);
    expect(s.phase).toBe('augmentSelect');
  });
});

describe('전체 게임 시뮬레이션 (봇끼리, 모든 증강 사용)', () => {
  it.each([2, 5, 8])('%i인 게임이 우승자 결정까지 오류 없이 진행되고 칩이 보존된다', (n) => {
    for (const seed of [1, 2]) {
      const s = playGame(n, seed * 31 + n, { handsPerLevel: 2 });
      expect(s.phase).toBe('gameOver');
      expect(s.players.filter((p) => !p.out)).toHaveLength(1);
      expect(new Set(s.players.map((p) => p.place))).toEqual(new Set(Array.from({ length: n }, (_, i) => i + 1)));
    }
  });
});
