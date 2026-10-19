// 방 설정(블라인드), 중도 참여, 추방 테스트
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
  blindsAt,
  addJoiner,
  getJoiner,
  joinerPending,
  joinerTimeout,
  kickPlayer,
  setLevelPlan,
  type CreateGameOptions,
  type GameAction,
  type GameState,
} from '../src/index.js';
import { expectedChips, makePlayers, stepBots, totalChips } from './helpers.js';

function ok(r: { ok: boolean; error?: string }) {
  if (!r.ok) throw new Error(r.error);
}
const act = (s: GameState, id: string, a: GameAction) => ok(applyAction(s, id, a));
const P = (s: GameState, id: string) => s.players.find((p) => p.id === id)!;
const toAct = (s: GameState) => getPending(s).playerIds[0];

function game(n: number, o: CreateGameOptions = {}): GameState {
  return createGame(
    makePlayers(n).map((p) => ({ ...p, isBot: false })),
    { rng: seededRng(7), debug: true, initialPick: false, dealerSeat: 0, ...o },
  );
}

/** 핸드를 끝까지: 차례인 사람은 체크/콜, 그 밖의 결정은 시간 초과 처리 */
function finishHand(s: GameState) {
  for (let i = 0; i < 200 && s.phase !== 'handEnd' && s.phase !== 'gameOver'; i++) {
    const pend = getPending(s);
    if (pend.kind === 'turn') {
      const l = legalActions(s, pend.playerIds[0])!;
      act(s, pend.playerIds[0], l.check ? { type: 'check' } : { type: 'call' });
    } else applyTimeouts(s);
  }
}

/** 다음 핸드로 (증강 선택은 무작위로 끝낸다) */
function nextHand(s: GameState) {
  ok(startNextHand(s));
  for (let i = 0; i < 20 && s.phase === 'augmentSelect'; i++) applyTimeouts(s);
}

describe('블라인드 설정', () => {
  it('기본 표: 시작 BB 의 1 → 2 → 4 → 7.5 → 15 → 30 → 60배 … (SB 는 절반)', () => {
    const bbs = Array.from({ length: 9 }, (_, i) => blindsAt(i, 20, 'standard'));
    expect(bbs.map((b) => `${b.sb}/${b.bb}`)).toEqual([
      '10/20', '20/40', '40/80', '75/150', '150/300', '300/600', '600/1200', '1200/2400', '2400/4800',
    ]);
    expect(blindsAt(3, 100, 'standard')).toEqual({ sb: 375, bb: 750 });
    expect(blindsAt(0, 2, 'standard')).toEqual({ sb: 1, bb: 2 });
  });

  it('1.5배씩: 보기 좋은 숫자로 반올림하며 항상 오른다', () => {
    const bbs = Array.from({ length: 10 }, (_, i) => blindsAt(i, 20, 'x1.5').bb);
    expect(bbs).toEqual([20, 30, 45, 70, 100, 150, 250, 400, 600, 900]);
    for (const base of [2, 3, 7, 13, 50, 999]) {
      const list = Array.from({ length: 15 }, (_, i) => blindsAt(i, base, 'x1.5').bb);
      list.forEach((bb, i) => i > 0 && expect(bb).toBeGreaterThan(list[i - 1]));
    }
  });

  it('시작 칩·시작 블라인드가 게임에 그대로 반영된다', () => {
    const s = game(3, { startingChips: 3000, bigBlind: 50 });
    nextHand(s);
    expect(s.players.every((p) => p.chips + p.contributed === 3000)).toBe(true);
    expect(getPlayerView(s, 'p1').blinds).toEqual({ sb: 25, bb: 50 });
    expect(P(s, 'p3').contributed).toBe(50);
  });

  it('고정 주기: N핸드마다 오른다', () => {
    const s = game(3, { levelMode: 'fixed', fixedLevelHands: 4, bigBlind: 20 });
    const seen: number[] = [];
    for (let h = 0; h < 9; h++) {
      nextHand(s);
      seen.push(getPlayerView(s, 'p1').blinds.bb);
      for (const p of s.players) p.chips = 10000; // 탈락 없이 진행
      finishHand(s);
    }
    expect(seen).toEqual([20, 20, 20, 20, 40, 40, 40, 40, 80]);
  });

  it('자동 주기: 그 레벨이 시작될 때 남은 인원 × 2핸드', () => {
    const s = game(4, { bigBlind: 20 });
    expect(s.levelHands).toBe(8);
    nextHand(s);
    expect(getPlayerView(s, 'p1').handsUntilLevelUp).toBe(8);
    // 한 명이 탈락한 상태로 다음 레벨이 시작되면 3 × 2 = 6핸드
    s.players[3].out = true;
    s.handNumber = 8;
    s.phase = 'handEnd';
    nextHand(s);
    expect(s.levelIndex).toBe(1);
    expect(s.levelHands).toBe(6);
    expect(getPlayerView(s, 'p1').handsPerLevel).toBe(6);
  });

  it('상승 주기를 게임 중에 바꾸면 다음 레벨부터 적용된다', () => {
    const s = game(3, { levelMode: 'fixed', fixedLevelHands: 4 });
    nextHand(s);
    setLevelPlan(s, 'fixed', 10);
    expect(s.levelHands).toBe(4);
    s.handNumber = 4;
    s.phase = 'handEnd';
    nextHand(s);
    expect(s.levelIndex).toBe(1);
    expect(s.levelHands).toBe(10);
  });
});

describe('중도 참여', () => {
  it('진행 중인 핸드에는 끼어들지 않고, 증강을 다 고른 뒤 다음 핸드 시작 때 앉는다', () => {
    const s = game(3, { startingChips: 1000, debug: true, initialPick: true });
    for (let i = 0; i < 10 && s.phase === 'augmentSelect'; i++) applyTimeouts(s);
    expect(s.phase).toBe('betting');
    // 레벨 2 선택 기회까지 지나간 상태라고 가정
    s.pickRounds = 2;
    ok(addJoiner(s, { id: 'j1', name: 'J', isBot: false }));
    const j = getJoiner(s, 'j1')!;
    expect(j.picksTotal).toBe(2);
    expect(s.players.some((p) => p.id === 'j1')).toBe(false);
    // 뷰: 관전 상태, 증강 선택지
    let v = getPlayerView(s, 'j1');
    expect(v.you.seated).toBe(false);
    expect(v.you.pick).toHaveLength(3);
    expect(v.you.legal).toBeNull();
    expect(v.you.joining).toEqual({ picksDone: 0, picksTotal: 2 });
    expect(v.log.some((x) => x.text.includes('J님이 참여했습니다'))).toBe(true);
    // 다른 사람의 행동은 막힘, 고르기만 가능
    expect(applyAction(s, 'j1', { type: 'fold' }).ok).toBe(false);
    act(s, 'j1', { type: 'pick', augment: v.you.pick![0].id });
    v = getPlayerView(s, 'j1');
    expect(v.you.joining).toEqual({ picksDone: 1, picksTotal: 2 });
    expect(joinerPending(s)).toHaveLength(1);
    // 제한 시간 종료 → 무작위
    joinerTimeout(s, 'j1');
    expect(getJoiner(s, 'j1')!.player.augments).toHaveLength(2);
    expect(joinerPending(s)).toHaveLength(0);
    // 다른 사람들 칩: 1000, 1200, 800 → 평균 1000 → 시작 칩과 같으면 1000, 평균이 더 작으면 평균
    finishHand(s);
    for (const [i, c] of [600, 900, 900].entries()) s.players[i].chips = c;
    const before = totalChips(s);
    nextHand(s);
    const joined = P(s, 'j1');
    expect(joined).toBeDefined();
    expect(joined.chips + joined.contributed).toBe(800);
    expect(s.stats.joinChips).toBe(800);
    expect(totalChips(s)).toBe(before + 800);
    expect(s.joiners).toHaveLength(0);
    expect(getPlayerView(s, 'j1').you.seated).toBe(true);
  });

  it('선택을 끝내지 못했으면 다음 핸드에도 앉지 않는다', () => {
    const s = game(2);
    nextHand(s);
    s.pickRounds = 1;
    ok(addJoiner(s, { id: 'j1', name: 'J', isBot: false }));
    finishHand(s);
    nextHand(s);
    expect(s.players.some((p) => p.id === 'j1')).toBe(false);
    joinerTimeout(s, 'j1');
    finishHand(s);
    nextHand(s);
    expect(s.players.some((p) => p.id === 'j1')).toBe(true);
  });

  it('앉기 전에 블라인드 상승(증강 선택)이 오면 그 선택도 받는다', () => {
    const s = game(2, { levelMode: 'fixed', fixedLevelHands: 2 });
    nextHand(s);
    s.pickRounds = 1;
    ok(addJoiner(s, { id: 'j1', name: 'J', isBot: false }));
    finishHand(s);
    nextHand(s);
    finishHand(s);
    ok(startNextHand(s)); // 레벨 상승 → 증강 선택
    expect(s.phase).toBe('augmentSelect');
    expect(getJoiner(s, 'j1')!.picksTotal).toBe(2);
  });

  it('중도 참여자는 이전 핸드의 로그와 다른 사람의 비공개 정보를 받지 않는다', () => {
    const s = game(3);
    ok(debugGiveAugment(s, 'p1', 'clairvoyance'));
    nextHand(s);
    act(s, toAct(s), { type: 'useAugment', augment: 'clairvoyance', targetId: 'p2' } as GameAction);
    applyTimeouts(s);
    ok(addJoiner(s, { id: 'j1', name: 'J', isBot: false }));
    const v = getPlayerView(s, 'j1');
    expect(v.log.every((x) => x.seq > 0 && !x.text.includes('핸드 #1'))).toBe(true);
    const json = JSON.stringify(v);
    for (const p of s.players) for (const c of p.hole) expect(json).not.toMatch(new RegExp(`"${c}"`));
    for (const c of s.board) expect(json).not.toMatch(new RegExp(`"${c}"`));
    expect(v.players.every((p) => p.shownCards === null)).toBe(true);
    expect(json).not.toContain('투시');
  });

  it('봇 게임 중 여러 명이 중도 참여해도 칩 보존이 깨지지 않고 끝까지 진행된다', () => {
    for (const seed of [1, 2, 3]) {
      const rng = seededRng(seed);
      const s = createGame(makePlayers(3), { rng, handsPerLevel: 3 });
      const initial = totalChips(s);
      let added = 0;
      for (let i = 0; i < 200000 && s.phase !== 'gameOver'; i++) {
        if (added < 3 && s.handNumber >= 2 + added * 2 && s.joiners.length === 0) {
          ok(addJoiner(s, { id: `j${added}`, name: `J${added}`, isBot: true }));
          added++;
        }
        for (const { id } of joinerPending(s)) joinerTimeout(s, id);
        stepBots(s, rng);
        if (s.phase !== 'reaction') expect(totalChips(s)).toBe(expectedChips(s, initial));
      }
      expect(s.phase).toBe('gameOver');
      expect(added).toBe(3);
    }
  });
});

describe('추방', () => {
  it('진행 중인 핸드는 폴드 처리, 낸 칩은 팟에 남고, 핸드가 끝나면 자리에서 제거되며 칩은 사라진다', () => {
    const s = game(3);
    ok(debugGiveAugment(s, 'p2', 'insurance'));
    nextHand(s);
    // p1 레이즈, p2(SB) 콜, p3 콜 → 플랍
    act(s, 'p1', { type: 'raise', amount: 100 });
    act(s, 'p2', { type: 'call' });
    act(s, 'p3', { type: 'call' });
    expect(s.street).toBe('flop');
    const potBefore = s.players.reduce((a, p) => a + p.contributed, 0);
    ok(kickPlayer(s, 'p2'));
    expect(P(s, 'p2').folded).toBe(true);
    expect(P(s, 'p2').contributed).toBe(100); // 보험 환급 없음
    expect(s.players.reduce((a, p) => a + p.contributed, 0)).toBe(potBefore);
    expect(getPlayerView(s, 'p1').players.find((p) => p.id === 'p2')!.kicked).toBe(true);
    expect(getPlayerView(s, 'p1').log.some((x) => x.text.includes('P2님이 추방되었습니다'))).toBe(true);
    expect(applyAction(s, 'p2', { type: 'check' }).ok).toBe(false);
    finishHand(s);
    const left = P(s, 'p2').chips;
    nextHand(s);
    expect(s.players.some((p) => p.id === 'p2')).toBe(false);
    expect(s.stats.kickedChips).toBe(left);
    expect(s.phase).toBe('betting');
  });

  it('차례인 사람을 추방하면 다음 사람에게 차례가 넘어간다', () => {
    const s = game(3);
    nextHand(s);
    expect(toAct(s)).toBe('p1');
    ok(kickPlayer(s, 'p1'));
    expect(toAct(s)).toBe('p2');
  });

  it('상대가 모두 추방되면 남은 사람이 팟을 가져가고 우승', () => {
    const s = game(2);
    nextHand(s);
    ok(kickPlayer(s, 'p2'));
    expect(s.phase).toBe('gameOver');
    expect(s.winnerId).toBe('p1');
    expect(P(s, 'p1').chips).toBe(1020);
    expect(s.stats.kickedChips).toBe(980);
  });

  it('다중 사이드팟이 깨지지 않는다', () => {
    const s = game(4);
    const deal = { board: 'As Ks Qs 2d 3c'.split(' '), hands: { p1: ['Js', 'Ts'], p2: ['2h', '2c'], p3: ['7h', '8h'], p4: ['9c', '9d'] } };
    ok(debugSetNextDeal(s, deal));
    s.players[0].chips = 300;
    s.players[1].chips = 600;
    s.players[2].chips = 900;
    s.players[3].chips = 2000;
    nextHand(s);
    // 순서: p4(UTG) → p1 → p2(SB) → p3(BB)
    act(s, 'p4', { type: 'raise', amount: 900 });
    act(s, 'p1', { type: 'allin' });
    act(s, 'p2', { type: 'allin' });
    ok(kickPlayer(s, 'p3')); // BB 20 은 팟에 남는다
    finishHand(s);
    const r = s.result!;
    const total = r.pots.reduce((a, p) => a + p.amount, 0);
    expect(total).toBe(300 + 600 + 20 + 600); // p4 의 초과분은 반환
    expect(r.won.p1).toBe(300 * 3 + 20); // 로열 플러시: 메인팟 (p3 의 BB 포함)
    expect(r.won.p2).toBe(600); // p2·p4 사이드팟: p2 의 2 트리플
    expect(r.won.p4 ?? 0).toBe(0);
    expect(P(s, 'p3').chips).toBe(880);
  });

  it('추방된 사람이 선언한 지속 효과(죽음과 세금, 다음 핸드 암전)는 즉시 끝난다', () => {
    const s = game(3);
    ok(debugGiveAugment(s, 'p2', 'deathTax'));
    ok(debugGiveAugment(s, 'p3', 'blackout'));
    nextHand(s);
    act(s, 'p2', { type: 'useAugment', augment: 'deathTax' } as GameAction);
    applyTimeouts(s);
    expect(s.taxers).toEqual(['p2']);
    finishHand(s);
    act(s, 'p3', { type: 'useAugment', augment: 'blackout' } as GameAction);
    applyTimeouts(s);
    expect(s.blackoutNext).toBe(true);
    ok(kickPlayer(s, 'p2'));
    ok(kickPlayer(s, 'p3'));
    expect(s.taxers).toEqual([]);
    expect(s.blackoutNext).toBe(false);
  });

  it('앉기 전의 중도 참여자도 추방할 수 있고, 탈락자는 추방 대상이 아니다', () => {
    const s = game(3);
    nextHand(s);
    ok(addJoiner(s, { id: 'j1', name: 'J', isBot: false }));
    ok(kickPlayer(s, 'j1'));
    expect(s.joiners).toHaveLength(0);
    s.players[2].out = true;
    expect(kickPlayer(s, 'p3').ok).toBe(false);
  });
});
