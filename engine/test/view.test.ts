// 플레이어 뷰 보안 테스트
// 1) 불간섭 검사: 보는 사람에게 숨겨진 정보(다른 사람의 홀카드·버린 카드·비공개 증강·덱·번 카드·미공개 보드·
//    안개에 가려진 플랍·반응 대기 중인 남의 선언 내용)를 마구 바꿔도 그 사람의 뷰가 한 글자도 달라지지 않아야 한다.
// 2) 카드 검사: 뷰에 등장하는 모든 카드 코드는 그 사람에게 허용된 카드여야 한다.
// 3) 공포탄 알림과 정보형 알림이 같은 형태인지, 반응 대기가 카운터 스펠 보유와 무관한지.
import { describe, expect, it } from 'vitest';
import {
  ALL_AUGMENT_IDS,
  AUGMENTS,
  applyAction,
  applyTimeouts,
  createGame,
  debugGiveAugment,
  getPending,
  getPlayerView,
  seededRng,
  shuffle,
  startNextHand,
  type AugmentId,
  type Card,
  type GameState,
  type Rng,
} from '../src/index.js';
import { makePlayers, stepBots } from './helpers.js';

function cloneState(s: GameState): GameState {
  return {
    ...s,
    options: { ...s.options },
    players: s.players.map((p) => structuredClone(p)),
    board: [...s.board],
    burns: [...s.burns],
    deck: [...s.deck],
    used: s.used.map((u) => ({ ...u })),
    effects: structuredClone(s.effects),
    declareQueue: [...s.declareQueue],
    reaction: s.reaction ? structuredClone(s.reaction) : null,
    result: s.result ? structuredClone(s.result) : null,
    nextDeal: s.nextDeal ? structuredClone(s.nextDeal) : null,
    taxers: [...s.taxers],
    stats: structuredClone(s.stats),
  };
}

function fogHides(s: GameState, viewerId: string, i: number): boolean {
  const e = s.effects;
  return i < 3 && e.fogSeers.length > 0 && !e.fogLifted && !e.fogSeers.includes(viewerId);
}

/** viewer 에게 숨겨진 모든 것을 무작위로 바꾼 사본 */
function perturb(s: GameState, viewerId: string, rng: Rng): GameState {
  const c = cloneState(s);
  const viewer = c.players.find((p) => p.id === viewerId)!;
  const glass = c.effects.glass;
  const slots: { get: () => Card; set: (x: Card) => void }[] = [];
  const addArr = (arr: Card[]) => arr.forEach((_, i) => slots.push({ get: () => arr[i], set: (x) => (arr[i] = x) }));
  for (const q of c.players) {
    const visible = q.inHand && (q.shown || glass || (q === viewer && !c.effects.blackout));
    if (!visible) addArr(q.hole);
    if (q !== viewer) addArr(q.discarded);
  }
  addArr(c.deck);
  const burnsUsed = c.used.filter((u) => u.kind === 'burn').length;
  for (let i = burnsUsed; i < c.burns.length; i++) {
    const idx = i;
    slots.push({ get: () => c.burns[idx], set: (x) => (c.burns[idx] = x) });
  }
  for (let i = 0; i < c.board.length; i++) {
    const hidden = (i >= c.boardRevealed && !viewer.foreseen.includes(i)) || (i < c.boardRevealed && fogHides(c, viewerId, i));
    if (!hidden) continue;
    const idx = i;
    slots.push({ get: () => c.board[idx], set: (x) => (c.board[idx] = x) });
  }
  // 버려진/폴드한 카드 목록은 카운팅 보유자에게만 보이는 별도 기록이므로, 같은 카드가 섞이지 않도록 자리 교환에서 뺀다
  const usedSet = new Set(c.used.map((u) => u.card));
  const movable = slots.filter((x) => !usedSet.has(x.get()));
  const pool = shuffle(movable.map((x) => x.get()), rng);
  movable.forEach((slot, i) => slot.set(pool[i]));
  // 다른 사람의 비공개 증강 정보
  for (const q of c.players) {
    if (q === viewer) continue;
    const used = new Set(q.augments.map((a) => a.id));
    for (const a of q.augments) {
      if (!a.revealed || a.publicId !== a.id) {
        const choices = ALL_AUGMENT_IDS.filter((id) => !used.has(id) && AUGMENTS[id].trigger === 'passive' && id !== 'counting');
        if (choices.length && !a.revealed) {
          used.delete(a.id);
          a.id = choices[rng.int(choices.length)];
          used.add(a.id);
        }
      }
      a.usesLeft = a.id === 'counterSpell' ? a.usesLeft : rng.int(4);
      a.armed = rng.int(2) === 0;
      a.fakeId = rng.int(2) ? ALL_AUGMENT_IDS[rng.int(ALL_AUGMENT_IDS.length)] : null;
      a.wildRank = 2 + rng.int(13);
      a.fakeUsed = rng.int(2) === 0;
    }
    if (q.pickOptions) q.pickOptions = shuffle([...ALL_AUGMENT_IDS], rng).slice(0, 1 + rng.int(3));
    if (q.pendingDiscard !== null) q.pendingDiscard = rng.int(3);
    q.notes = q.notes.map((n) => ({ ...n, text: `secret-${rng.int(1e6)}`, cards: ['2c'] }));
    q.skipPicks = rng.int(2);
    q.foreseen = rng.int(2) ? [3] : [];
    q.shepherdLied = rng.int(2) === 0;
    q.keptCard = rng.int(2) ? '2c' : null;
  }
  // 반응 대기 중인 남의 선언: 이름 숨김 선언의 실제 증강·대상
  for (const d of c.reaction?.queue ?? []) {
    if (d.ownerId === viewerId) continue;
    if (d.anonymous) {
      const anon = ALL_AUGMENT_IDS.filter((id) => AUGMENTS[id].disclosure === 'anonymous');
      d.augment = anon[rng.int(anon.length)];
      d.params = { targetId: c.players[rng.int(c.players.length)].id };
    }
  }
  return c;
}

const CARD_RE = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?![A-Za-z0-9])/g;

function allowedCards(s: GameState, viewerId: string): Set<Card> {
  const me = s.players.find((p) => p.id === viewerId)!;
  const ok = new Set<Card>([...me.discarded]);
  if (me.inHand && (me.shown || s.effects.glass || !s.effects.blackout)) me.hole.forEach((c) => ok.add(c));
  s.board.slice(0, s.boardRevealed).forEach((c, i) => {
    if (!fogHides(s, viewerId, i)) ok.add(c);
  });
  for (const p of s.players) {
    if (p.inHand && (p.shown || s.effects.glass)) p.hole.forEach((c) => ok.add(c));
    p.shepherdShown.forEach((c) => ok.add(c));
  }
  for (const n of me.notes) if (n.hand === s.handNumber) n.cards?.forEach((c) => ok.add(c));
  if (me.augments.some((a) => a.id === 'counting')) s.used.forEach((u) => ok.add(u.card));
  s.used.filter((u) => u.kind === 'rewind').forEach((u) => ok.add(u.card));
  s.result?.board.forEach((c) => ok.add(c));
  s.result?.entries.forEach((e) => e.cards.forEach((c) => ok.add(c)));
  return ok;
}

function checkAllViews(s: GameState, rng: Rng) {
  for (const p of s.players) {
    const view = getPlayerView(s, p.id);
    const json = JSON.stringify(view);
    const other = JSON.stringify(getPlayerView(perturb(s, p.id, rng), p.id));
    if (other !== json) {
      const a = JSON.parse(json);
      const b = JSON.parse(other);
      const diff = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      throw new Error(`view of ${p.id} depends on hidden info in [${diff.join(', ')}] (hand ${s.handNumber}, phase ${s.phase})`);
    }
    // 카운팅의 "모르는 카드" 목록은 여집합이라 검사에서 뺀다
    const current = {
      ...view,
      log: view.log.filter((e) => e.hand === s.handNumber),
      you: { ...view.you, counting: view.you.counting ? { ...view.you.counting, unseen: [], outCards: [] } : null },
    };
    const ok = allowedCards(s, p.id);
    for (const m of JSON.stringify(current).match(CARD_RE) ?? []) {
      if (!ok.has(m)) throw new Error(`${p.id} can see forbidden card ${m} (hand ${s.handNumber}, phase ${s.phase})`);
    }
    for (const pv of view.players) {
      const real = s.players.find((x) => x.id === pv.id)!;
      expect(pv.augmentCount).toBe(real.augments.length);
      expect(pv.revealedAugments.length).toBe(real.augments.filter((a) => a.revealed).length);
    }
  }
}

describe('플레이어 뷰에 다른 사람의 비공개 정보가 없다', () => {
  it.each([
    [2, 5],
    [4, 6],
    [8, 7],
    [6, 8],
  ])('%i인 봇 게임의 모든 단계 (증강 대량 사용)', (n, seed) => {
    const rng = seededRng(seed);
    const checkRng = seededRng(seed + 1000);
    const s = createGame(makePlayers(n), { rng, handsPerLevel: 1 });
    let steps = 0;
    while (s.phase !== 'gameOver' && steps < 2500) {
      checkAllViews(s, checkRng);
      stepBots(s, rng);
      steps++;
    }
    checkAllViews(s, checkRng);
    expect(steps).toBeGreaterThan(10);
  });

  it('엔진 상태 자체(덱 등)는 뷰에 포함되지 않는다', () => {
    const s = createGame(makePlayers(3), { rng: seededRng(1) });
    const v = getPlayerView(s, 'p1') as unknown as Record<string, unknown>;
    for (const key of ['deck', 'burns', 'used', 'rng', 'options', 'reactionQueue', 'nextDeal', 'stats']) expect(v).not.toHaveProperty(key);
  });
});

describe('알림과 반응 대기의 형태', () => {
  function game(augs: Record<string, AugmentId[]>) {
    const s = createGame(makePlayers(3), { rng: seededRng(9), debug: true, initialPick: false, dealerSeat: 0 });
    for (const [id, list] of Object.entries(augs)) for (const a of list) debugGiveAugment(s, id, a);
    startNextHand(s);
    return s;
  }
  /** 보는 사람(p3) 입장의 알림·반응 대기 모습 (이름만 바꿔서 비교) */
  function observed(s: GameState, declarer: string) {
    const v = getPlayerView(s, 'p3');
    const name = s.players.find((p) => p.id === declarer)!.name;
    const strip = (x: string) => x.replaceAll(name, '○○').replaceAll(declarer, '○○');
    return {
      log: strip(v.log.at(-1)!.text),
      reaction: strip(JSON.stringify(v.reaction)),
      pending: getPending(s).kind,
      pendingIds: getPending(s).playerIds,
      phase: v.phase,
      waiting: v.waiting,
    };
  }

  it('공포탄 알림은 정보형 증강 알림과 완전히 같은 형태', () => {
    const blankGame = game({ p1: ['blank', 'mulligan'] });
    applyAction(blankGame, 'p1', { type: 'useAugment', augment: 'blank' });
    const infoGame = game({ p1: ['clairvoyance'] });
    applyAction(infoGame, 'p1', { type: 'useAugment', augment: 'clairvoyance', targetId: 'p3' });
    const thermalGame = game({ p1: ['thermal'] });
    applyAction(thermalGame, 'p1', { type: 'useAugment', augment: 'thermal', targetId: 'p2' });
    const a = observed(blankGame, 'p1');
    expect(a.log).toBe('○○님이 비공개 증강을 사용했습니다');
    expect(observed(infoGame, 'p1')).toEqual(a);
    expect(observed(thermalGame, 'p1')).toEqual(a);
  });

  it('반응 대기는 카운터 스펠 보유 여부와 관계없이 같은 모습 (보유자 본인 화면에만 버튼)', () => {
    const without = game({ p1: ['glassTable'] });
    applyAction(without, 'p1', { type: 'useAugment', augment: 'glassTable' });
    const withCs = game({ p1: ['glassTable'], p2: ['counterSpell'] });
    applyAction(withCs, 'p1', { type: 'useAugment', augment: 'glassTable' });
    expect(observed(withCs, 'p1')).toEqual(observed(without, 'p1'));
    expect(getPlayerView(withCs, 'p2').reaction!.canCounter).toBe(true);
    // 어느 쪽이든 시간이 지나면 적용 (카운터가 없으면 그대로)
    applyTimeouts(without);
    applyTimeouts(withCs);
    expect(without.effects.glass).toBe(true);
    expect(withCs.effects.glass).toBe(true);
  });
});
