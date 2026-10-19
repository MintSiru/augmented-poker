// 통합 테스트: 실제 서버를 띄우고 가상 클라이언트(socket.io-client)를 여러 개 접속시켜 진행한다.
import { afterEach, describe, expect, it } from 'vitest';
import { io as connectClient, type Socket } from 'socket.io-client';
import { createAppServer, type AppServer } from '../src/index.js';
import type { Room } from '../src/rooms.js';
import type { ChatMessage, GameEnvelope, LobbyState, RoomListItem } from '../src/protocol.js';
import type { GameState } from '../../engine/src/index.js';

type Res = { ok: boolean; error?: string; code?: string; token?: string; playerId?: string };

let server: AppServer | null = null;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await server?.close();
  server = null;
});

/** 기본은 모든 시간을 0.005배로 (30초 제한 → 150ms, 봇 1~2초 → 5~10ms). 직접 조작하는 테스트는 1배. */
async function start(debug = false, timeScale = 0.005) {
  server = await createAppServer(0, { debug, timeScale });
  return server;
}

const CARD_RE = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?![A-Za-z0-9])/g;

/** 서버가 만든 봉투(envelope)에 받는 사람이 알 수 없는 카드가 들어 있지 않은지 (만드는 순간의 서버 상태 기준) */
function assertEnvelopePrivate(env: GameEnvelope, g: GameState, forId: string) {
  const me = (g.players.find((p) => p.id === forId) ?? g.joiners.find((j) => j.player.id === forId)?.player ?? g.retired.find((p) => p.id === forId))!;
  const e = g.effects;
  const fogged = (i: number) => i < 3 && e.fogSeers.length > 0 && !e.fogLifted && !e.fogSeers.includes(forId);
  const forbidden = new Set<string>();
  for (const p of g.players) {
    const visible = p.inHand && (p.shown || e.glass || (p === me && !e.blackout));
    if (!visible) p.hole.forEach((c) => forbidden.add(c));
    if (p !== me) p.discarded.forEach((c) => forbidden.add(c));
    // 애착으로 가져갈 카드는 쇼다운에서 이미 공개된 카드 (다음 핸드에서는 홀카드 규칙으로 가려진다)
    if (p !== me && p.keptCard && !p.shown) forbidden.add(p.keptCard);
  }
  g.deck.forEach((c) => forbidden.add(c));
  g.burns.forEach((c) => forbidden.add(c));
  g.board.forEach((c, i) => {
    if ((i >= g.boardRevealed && !me.foreseen.includes(i)) || (i < g.boardRevealed && fogged(i))) forbidden.add(c);
  });
  // 합법적으로 알게 된 카드: 이번 핸드의 내 메모(투시·예지·관찰자 등), 카운팅으로 본 사용된 카드, 공개된 카드
  for (const n of me.notes) if (n.hand === g.handNumber) n.cards?.forEach((c) => forbidden.delete(c));
  if (me.augments.some((a) => a.id === 'counting')) g.used.forEach((u) => forbidden.delete(u.card));
  g.used.filter((u) => u.kind === 'rewind').forEach((u) => forbidden.delete(u.card));
  for (const p of g.players) p.shepherdShown.forEach((c) => forbidden.delete(c));
  const v = env.view;
  const current = {
    ...env,
    view: {
      ...v,
      log: v.log.filter((x) => x.hand === g.handNumber),
      // 카운팅의 "모르는 카드" 목록은 52장의 여집합이라 검사에서 뺀다
      you: { ...v.you, counting: v.you.counting ? { ...v.you.counting, unseen: [], outCards: [] } : null },
    },
  };
  const found = JSON.stringify(current).match(CARD_RE) ?? [];
  const leaked = found.filter((c) => forbidden.has(c));
  if (leaked.length) {
    const j = JSON.stringify(current);
    const at = j.search(new RegExp(`(?<![A-Za-z0-9])${leaked[0]}(?![A-Za-z0-9])`));
    throw new Error(`envelope for ${forId} leaks ${leaked.join(',')} (phase ${g.phase}) near: ${j.slice(Math.max(0, at - 200), at + 40)} | burns ${g.burns} used ${JSON.stringify(g.used)}`);
  }
  if (env.view.you.id !== forId) throw new Error('envelope addressed to wrong player');
  for (const key of ['deck', 'burns', 'used', 'rng', 'options', 'stats']) if (key in (env.view as object)) throw new Error(`state field ${key} leaked`);
}

function watchRoom(room: Room) {
  const orig = room.envelope.bind(room);
  let checked = 0;
  room.envelope = (forId: string) => {
    const env = orig(forId);
    assertEnvelopePrivate(env, room.game!, forId);
    checked++;
    return env;
  };
  return () => checked;
}

class VClient {
  sock: Socket;
  lobby: LobbyState | null = null;
  env: GameEnvelope | null = null;
  id = '';
  token = '';
  code = '';
  received: GameEnvelope[] = [];
  auto = true;

  constructor(port: number) {
    this.sock = connectClient(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(this.sock);
    this.attach();
  }

  attach() {
    this.sock.on('lobby', (s: LobbyState) => (this.lobby = s));
    this.sock.on('game', (e: GameEnvelope) => {
      this.env = e;
      this.received.push(e);
      if (this.auto) this.play(e);
    });
  }

  emit(event: string, payload: unknown = {}, timeoutMs = 2000): Promise<Res> {
    return new Promise((resolve) => {
      this.sock.timeout(timeoutMs).emit(event, payload, (err: unknown, res: Res) => resolve(err ? { ok: false, error: 'timeout' } : res));
    });
  }

  async ready() {
    if (!this.sock.connected) await new Promise<void>((r) => this.sock.once('connect', () => r()));
  }

  async create(name: string) {
    await this.ready();
    const r = await this.emit('room:create', { name });
    expect(r.ok).toBe(true);
    Object.assign(this, { id: r.playerId, token: r.token, code: r.code });
    return r;
  }

  async join(code: string, name: string, prevToken?: string) {
    await this.ready();
    const r = await this.emit('room:join', { code, name, prevToken });
    if (r.ok) Object.assign(this, { id: r.playerId, token: r.token, code: r.code });
    return r;
  }

  /** 단순 정책: 증강은 첫 번째, 세 번째 손은 첫 카드 버림, 선언 기회는 넘김, 베팅은 올인(가능하면) */
  play(e: GameEnvelope) {
    const v = e.view;
    if (v.you.pick?.length) void this.emit('game:action', { type: 'pick', augment: v.you.pick[0].id });
    else if (v.you.discard?.pending) void this.emit('game:action', { type: 'discard', cardIndex: 0 });
    else if (v.you.declare) void this.emit('game:action', { type: 'declare', augment: null });
    else if (v.you.attach) void this.emit('game:action', { type: 'attach', cardIndex: 0 });
    else if (v.you.legal) {
      const l = v.you.legal;
      void this.emit('game:action', l.allIn ? { type: 'allin' } : l.check ? { type: 'check' } : { type: 'call' });
    }
  }

  async reconnect(port: number) {
    this.sock = connectClient(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(this.sock);
    this.attach();
    await this.ready();
    return this.emit('room:resume', { token: this.token });
  }
}

async function waitFor(pred: () => boolean, ms = 20000, label = 'condition') {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('방과 접속', () => {
  it('방 만들기 → 코드로 입장 → 설정 → 시작, 권한과 입력 검증', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    await a.create('철수');
    expect(a.code).toMatch(/^[A-Z0-9]{5}$/);
    expect((await b.join('ZZZZZ', '영희')).ok).toBe(false);
    expect((await b.join(a.code.toLowerCase(), '영희')).ok).toBe(true); // 소문자 입력도 허용
    expect((await b.join(a.code, '')).ok).toBe(false);
    await waitFor(() => a.lobby?.players.length === 2, 2000, 'lobby update');
    expect(a.lobby!.hostId).toBe(a.id);
    // 방장이 아니면 설정/시작 불가
    expect((await b.emit('room:settings', { maxPlayers: 4 })).ok).toBe(false);
    expect((await b.emit('room:start')).ok).toBe(false);
    expect((await a.emit('room:settings', { maxPlayers: 9 })).ok).toBe(false);
    expect((await a.emit('room:settings', { maxPlayers: 4, fillBots: true, botCount: 1, turnSeconds: 30 })).ok).toBe(true);
    await waitFor(() => b.lobby?.settings.maxPlayers === 4, 2000, 'settings broadcast');
    a.auto = false;
    b.auto = false;
    expect((await a.emit('room:start')).ok).toBe(true);
    await waitFor(() => !!a.env && !!b.env, 2000, 'game start');
    expect(a.env!.view.players).toHaveLength(3);
    expect(a.env!.view.players.filter((p) => p.isBot)).toHaveLength(1);
    // 중도 참여를 끄면 시작 후에는 새로 입장할 수 없다
    expect((await a.emit('room:settings', { midJoin: false })).ok).toBe(true);
    const c = new VClient(s.port);
    const r = await c.join(a.code, '민수');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('시작');
  });

  it('방장이 나가면 다음 순서의 플레이어에게 방장 권한이 넘어간다', async () => {
    const s = await start();
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    await a.emit('room:leave');
    await waitFor(() => b.lobby?.players.length === 2, 2000, 'leave');
    expect(b.lobby!.hostId).toBe(b.id);
    // 연결이 끊겨도 넘어간다
    b.sock.disconnect();
    await waitFor(() => c.lobby?.hostId === c.id, 2000, 'host transfer on disconnect');
  });

  it('방장은 접속 중인 다른 사람에게 방장을 넘길 수 있다 (대기실·게임 중, 모두에게 알림)', async () => {
    const s = await start();
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    const got: ChatMessage[] = [];
    c.sock.on('chat', (m: ChatMessage) => got.push(m));
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    // 방장이 아니면 넘길 수 없다, 없는 사람·자기 자신도 안 된다
    expect((await b.emit('room:host', { playerId: c.id })).error).toContain('방장');
    expect((await a.emit('room:host', { playerId: 'nope' })).ok).toBe(false);
    expect((await a.emit('room:host', { playerId: a.id })).ok).toBe(false);
    expect((await a.emit('room:host', { playerId: b.id })).ok).toBe(true);
    await waitFor(() => c.lobby?.hostId === b.id, 2000, 'host given');
    await waitFor(() => got.some((m) => m.fromId === '' && m.text.includes('방장')), 2000, 'notice');
    // 예전 방장은 이제 시작할 수 없고, 새 방장이 시작한다
    expect((await a.emit('room:start')).ok).toBe(false);
    expect((await b.emit('room:start')).ok).toBe(true);
    await waitFor(() => !!c.env, 3000, 'game');
    // 게임 중에도 넘길 수 있다 (연결 끊긴 사람에게는 안 됨)
    a.sock.disconnect();
    await waitFor(() => c.env?.view.players.find((p) => p.id === a.id)?.connected === false, 3000, 'a off');
    expect((await b.emit('room:host', { playerId: a.id })).error).toContain('접속 중');
    expect((await b.emit('room:host', { playerId: c.id })).ok).toBe(true);
    await waitFor(() => c.env?.youAreHost === true, 3000, 'c host');
    expect(c.env!.view.players.find((p) => p.id === c.id)!.isHost).toBe(true);
  });

  it('모든 사람이 나간 방은 일정 시간 뒤 삭제된다', async () => {
    const s = await start();
    const a = new VClient(s.port);
    await a.create('A');
    expect(s.rooms.rooms.size).toBe(1);
    a.sock.disconnect();
    // 10분 × 0.005 = 3초
    await waitFor(() => s.rooms.rooms.size === 0, 6000, 'room deletion');
  });

  it('각 클라이언트에는 자기 뷰만 따로 전송된다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    await waitFor(() => a.received.length > 0 && b.received.length > 0, 2000, 'views');
    const room = s.rooms.rooms.get(a.code)!;
    const g = room.game!;
    for (const e of a.received) expect(e.view.you.id).toBe(a.id);
    for (const e of b.received) expect(e.view.you.id).toBe(b.id);
    await waitFor(() => !!a.env?.view.you.pick && !!b.env?.view.you.pick, 2000, 'pick');
    // 증강 선택 → 카드 배분 후, 상대 홀카드가 내 수신 데이터에 없다
    await a.emit('game:action', { type: 'pick', augment: a.env!.view.you.pick![0].id });
    await b.emit('game:action', { type: 'pick', augment: b.env!.view.you.pick![0].id });
    await waitFor(() => g.phase === 'betting' && !!a.env?.view.you.hole.length && !!b.env?.view.you.hole.length, 2000, 'deal');
    const bHole = g.players.find((p) => p.id === b.id)!.hole;
    const aRaw = JSON.stringify(a.received);
    for (const c of bHole) expect(aRaw).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
  });
});

describe('한 판 끝까지', () => {
  it('사람 3명 + 봇 2명이 우승자 결정까지 진행 (모든 전송의 비공개 정보 검사)', async () => {
    const s = await start();
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    const room = s.rooms.rooms.get(a.code)!;
    await a.emit('room:settings', { fillBots: true, botCount: 2, turnSeconds: 10 });
    const origStart = room.start.bind(room);
    let checked = () => 0;
    room.start = (m) => {
      const err = origStart(m);
      checked = watchRoom(room);
      return err;
    };
    expect((await a.emit('room:start')).ok).toBe(true);
    await waitFor(() => room.game?.phase === 'gameOver', 60000, 'game over');
    const g = room.game!;
    expect(g.winnerId).not.toBeNull();
    expect(g.players.filter((p) => !p.out)).toHaveLength(1);
    expect(checked()).toBeGreaterThan(20);
    await waitFor(() => a.env?.view.phase === 'gameOver', 2000, 'client sees game over');
    expect(a.env!.view.winnerId).toBe(g.winnerId);
    // 방장은 같은 멤버로 대기실로 돌아갈 수 있다
    expect((await a.emit('room:lobby')).ok).toBe(true);
    await waitFor(() => a.lobby !== null && room.game === null, 2000, 'back to lobby');
  });

  it('중간에 연결이 끊겼다가 같은 토큰으로 돌아오면 자기 자리로 복귀한다', async () => {
    const s = await start();
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:settings', { fillBots: true, botCount: 1, turnSeconds: 10 });
    const room = s.rooms.rooms.get(a.code)!;
    b.auto = false; // B는 일단 아무것도 안 함 → 증강 선택은 시간 초과로 무작위
    await a.emit('room:start');
    await waitFor(() => room.game?.phase === 'betting', 5000, 'first hand');
    const g = room.game!;
    const hand = g.handNumber;
    const holeBefore = [...g.players.find((p) => p.id === b.id)!.hole];
    // B 연결 끊김
    b.sock.disconnect();
    await waitFor(() => a.env?.view.players.find((p) => p.id === b.id)?.connected === false, 2000, 'disconnect shown');
    expect(room.member(b.id)!.connected).toBe(false);
    // 다시 접속 (새 소켓 + 토큰)
    const r = await b.reconnect(s.port);
    expect(r.ok).toBe(true);
    expect(r.playerId).toBe(b.id);
    await waitFor(() => !!b.env, 2000, 'state after resume');
    if (g.handNumber === hand && !g.players.find((p) => p.id === b.id)!.folded) {
      expect(b.env!.view.you.hole).toEqual(holeBefore);
    }
    expect(b.env!.view.you.id).toBe(b.id);
    await waitFor(() => a.env?.view.players.find((p) => p.id === b.id)?.connected === true, 2000, 'reconnect shown');
    // 이후 정상 진행
    b.auto = true;
    if (b.env) b.play(b.env);
    await waitFor(() => g.phase === 'gameOver', 60000, 'game over after reconnect');
  });

  it('끊긴 플레이어는 시간 초과로 자동 체크/폴드되고, 3핸드 연속 부재면 자리 비움(블라인드만 냄)', async () => {
    const s = await start();
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    const room = s.rooms.rooms.get(a.code)!;
    expect((await a.emit('room:settings', { autoKickMinutes: 0 })).ok).toBe(true);
    // 빨리 끝나지 않도록 A, C는 체크/콜만
    for (const cl of [a, c]) {
      cl.play = (e: GameEnvelope) => {
        const v = e.view;
        if (v.you.pick?.length) void cl.emit('game:action', { type: 'pick', augment: v.you.pick[0].id });
        else if (v.you.discard?.pending) void cl.emit('game:action', { type: 'discard', cardIndex: 0 });
        else if (v.you.declare) void cl.emit('game:action', { type: 'declare', augment: null });
        else if (v.you.legal) void cl.emit('game:action', v.you.legal.check ? { type: 'check' } : { type: 'call' });
      };
    }
    await a.emit('room:start');
    b.sock.disconnect();
    await waitFor(() => !!room.game && room.game.handNumber >= 5, 30000, 'several hands');
    const pb = room.game!.players.find((p) => p.id === b.id)!;
    expect(pb.sittingOut).toBe(true);
    expect(room.game!.log.some((e) => e.text.includes('자리 비움'))).toBe(true);
    // 돌아오면 자리 비움 해제
    const r = await b.reconnect(s.port);
    expect(r.ok).toBe(true);
    expect(pb.sittingOut).toBe(false);
  });

  it('다른 창에서 같은 토큰으로 접속하면 이전 창은 끊긴다', async () => {
    const s = await start();
    const a = new VClient(s.port);
    await a.create('A');
    let kicked = '';
    a.sock.on('kicked', (r: string) => (kicked = r));
    const a2 = new VClient(s.port);
    await a2.ready();
    a2.token = a.token;
    const r = await a2.emit('room:resume', { token: a.token });
    expect(r.ok).toBe(true);
    await waitFor(() => kicked !== '', 2000, 'kick');
  });
});

/** 체크/콜만 하는 정책 (게임이 빨리 끝나지 않도록) */
function passive(cl: VClient) {
  cl.play = (e: GameEnvelope) => {
    const v = e.view;
    if (v.you.pick?.length) void cl.emit('game:action', { type: 'pick', augment: v.you.pick[0].id });
    else if (v.you.discard?.pending) void cl.emit('game:action', { type: 'discard', cardIndex: 0 });
    else if (v.you.declare) void cl.emit('game:action', { type: 'declare', augment: null });
    else if (v.you.attach) void cl.emit('game:action', { type: 'attach', cardIndex: 0 });
    else if (v.you.legal) void cl.emit('game:action', v.you.legal.check ? { type: 'check' } : { type: 'call' });
  };
}

describe('공개 방 목록과 방 설정', () => {
  it('공개 방은 다른 브라우저의 목록에 바로 나타나고 실시간으로 갱신된다 (게임 내용은 없음)', async () => {
    const s = await start();
    const watcher = new VClient(s.port);
    let list: RoomListItem[] = [];
    let raw = '';
    watcher.sock.on('rooms', (l: RoomListItem[]) => {
      list = l;
      raw = JSON.stringify(l);
    });
    await watcher.ready();
    await watcher.emit('rooms:watch', { on: true });
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    passive(a);
    await a.ready();
    expect((await a.emit('room:create', { name: '철수', roomName: '즐거운 방', isPublic: true })).ok).toBe(true);
    const code = s.rooms.publicList()[0].code;
    a.code = code;
    await b.ready();
    expect((await b.emit('room:create', { name: '영희', isPublic: false })).ok).toBe(true);
    await waitFor(() => list.length === 1 && list[0].name === '즐거운 방', 2000, 'public list');
    expect(list[0]).toEqual({
      code, name: '즐거운 방', players: 1, maxPlayers: 8, status: 'waiting', midJoin: true, joinable: true,
      startingChips: 1000, smallBlind: 10, bigBlind: 20, augPool: '전체',
    });
    // 비공개 방의 기본 이름
    const priv = [...s.rooms.rooms.values()].find((r) => !r.isPublic)!;
    expect(priv.name).toBe('영희님의 방');
    // 목록에서 입장 → 인원 변화 반영
    const c = new VClient(s.port);
    passive(c);
    expect((await c.join(code, '민수')).ok).toBe(true);
    await waitFor(() => list[0]?.players === 2, 2000, 'count update');
    // 설정 변경 반영, 시작하면 게임 중 + 대기 중인 방이 위로
    expect((await a.emit('room:settings', { startingChips: 2000, bigBlind: 40, fillBots: true, botCount: 1, autoKickMinutes: 0 })).ok).toBe(true);
    await waitFor(() => list[0]?.bigBlind === 40, 2000, 'settings in list');
    expect((await a.emit('room:settings', { isPublic: false })).ok).toBe(true);
    await waitFor(() => list.length === 0, 2000, 'hidden');
    expect((await a.emit('room:settings', { isPublic: true })).ok).toBe(true);
    const d = new VClient(s.port);
    await d.ready();
    await d.emit('room:create', { name: 'D', roomName: '새 방' });
    expect((await a.emit('room:start')).ok).toBe(true);
    await waitFor(() => list.length === 2 && list[1].status === 'playing', 3000, 'playing status');
    expect(list[0].name).toBe('새 방');
    expect(list[1].players).toBe(3);
    // 목록에는 게임 내용이 절대 들어가지 않는다
    expect(raw).not.toMatch(/"(view|players\"\s*:\s*\[|hole|board|log|augments)"/);
    expect(raw).not.toMatch(CARD_RE);
    // 꽉 차면 입장 불가로 표시
    expect((await a.emit('room:settings', { maxPlayers: 3 })).ok).toBe(true);
    await waitFor(() => list[1]?.joinable === false, 2000, 'full');
    const e = new VClient(s.port);
    expect((await e.join(code, 'E')).ok).toBe(false);
    // 방이 삭제되면 목록에서 사라진다
    for (const r of [...s.rooms.rooms.values()]) r.destroy();
    await waitFor(() => list.length === 0, 2000, 'deleted');
  });

  it('0명이 된 방은 바로 삭제되고, 접속자가 없는 방은 목록에 보이지 않는다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    await a.create('A');
    await b.ready();
    await b.emit('room:create', { name: 'B', roomName: '끊긴 방' });
    expect(s.rooms.rooms.size).toBe(2);
    // 모두 나가면(0명) 바로 삭제
    await a.emit('room:leave');
    await waitFor(() => s.rooms.rooms.size === 1, 2000, 'empty room deleted');
    // 연결만 끊긴 방은 재접속을 기다리지만 목록에서는 숨긴다
    expect(s.rooms.publicList().map((r) => r.name)).toEqual(['끊긴 방']);
    b.sock.disconnect();
    await waitFor(() => s.rooms.publicList().length === 0, 2000, 'hidden from list');
    expect(s.rooms.rooms.size).toBe(1);
    // 새로고침: 목록을 다시 받는다
    const c = new VClient(s.port);
    let got: RoomListItem[] | null = null;
    c.sock.on('rooms', (l: RoomListItem[]) => (got = l));
    await c.ready();
    expect((await c.emit('rooms:watch', { on: true })).ok).toBe(true);
    await waitFor(() => got !== null, 2000, 'list refresh');
  });

  it('동시에 존재할 수 있는 방 수를 제한한다', async () => {
    server = await createAppServer(0, { maxRooms: 2, timeScale: 0.005 });
    const s = server;
    const cs = [new VClient(s.port), new VClient(s.port), new VClient(s.port)];
    for (const c of cs) await c.ready();
    expect((await cs[0].emit('room:create', { name: 'A' })).ok).toBe(true);
    expect((await cs[1].emit('room:create', { name: 'B' })).ok).toBe(true);
    const r = await cs[2].emit('room:create', { name: 'C' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('최대 2개');
  });

  it('설정값 검증, 10BB 미만 시작 불가, 시작 후 칩·블라인드 잠금, 설정이 게임에 반영', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    for (const bad of [{ startingChips: 100 }, { startingChips: 20000 }, { bigBlind: 1 }, { bigBlind: 2000 }, { turnSeconds: 10 }, { turnSeconds: 61 },
      { levelHands: 3 }, { levelHands: 31 }, { levelMode: 'x' }, { blindSchedule: 'double' }, { autoKickMinutes: 7 }, { midJoin: 'yes' }]) {
      expect((await a.emit('room:settings', bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await b.emit('room:settings', { startingChips: 5000 })).ok).toBe(false);
    expect((await a.emit('room:settings', { startingChips: 500, bigBlind: 100 })).ok).toBe(true);
    const r = await a.emit('room:start');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('10BB');
    expect((await a.emit('room:settings', { startingChips: 2000, bigBlind: 50, levelMode: 'fixed', levelHands: 5, blindSchedule: 'x1.5', turnSeconds: 45 })).ok).toBe(true);
    expect((await a.emit('room:start')).ok).toBe(true);
    await waitFor(() => !!a.env, 2000, 'start');
    const room = s.rooms.rooms.get(a.code)!;
    expect(room.game!.options).toMatchObject({ startingChips: 2000, bigBlind: 50, levelMode: 'fixed', fixedLevelHands: 5, blindSchedule: 'x1.5' });
    expect(a.env!.view.blinds).toEqual({ sb: 25, bb: 50 });
    expect(a.env!.view.handsPerLevel).toBe(5);
    // 시작 후: 칩·블라인드는 잠기고, 나머지는 바꿀 수 있다 (상승 주기는 다음 레벨부터)
    expect((await a.emit('room:settings', { startingChips: 3000 })).ok).toBe(false);
    expect((await a.emit('room:settings', { bigBlind: 20 })).ok).toBe(false);
    expect((await a.emit('room:settings', { blindSchedule: 'standard' })).ok).toBe(false);
    expect((await a.emit('room:settings', { turnSeconds: 20, maxPlayers: 6, midJoin: false, autoKickMinutes: 10, isPublic: false, levelHands: 8 })).ok).toBe(true);
    expect(room.settings.turnSeconds).toBe(20);
    expect(room.game!.options.fixedLevelHands).toBe(8);
    expect((await b.emit('room:settings', { turnSeconds: 30 })).ok).toBe(false);
  });

  it('증강 풀: 프리셋·직접 고르기, 별마다 3개 미만이면 시작 불가, 목록 표시, 시작 후 잠금, 게임에 반영', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    a.auto = false;
    await a.create('A');
    await a.emit('room:settings', { fillBots: true, botCount: 1 });
    expect((await a.emit('room:settings', { augPool: 'x' })).ok).toBe(false);
    expect((await a.emit('room:settings', { augCustom: 'thermal' })).ok).toBe(false);
    // 직접 고르기: ★만 4개 → 부족
    expect((await a.emit('room:settings', { augPool: 'custom', augCustom: ['thermal', 'observer', 'mulligan', 'insurance', 'nope'] })).ok).toBe(true);
    const room = s.rooms.rooms.get(a.code)!;
    expect(room.settings.augCustom).toEqual(['observer', 'thermal', 'mulligan', 'insurance']);
    expect(s.rooms.publicList().find((r) => r.code === a.code)!.augPool).toBe('직접 고름(4개)');
    const r = await a.emit('room:start');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('★★ 3개');
    expect(r.error).toContain('★★★ 3개');
    // 10개: 별마다 3개 이상
    const ten = ['thermal', 'observer', 'mulligan', 'insurance', 'clairvoyance', 'foresight', 'counting', 'rewind', 'restart', 'seal'];
    expect((await a.emit('room:settings', { augCustom: ten })).ok).toBe(true);
    expect((await a.emit('room:start')).ok).toBe(true);
    await waitFor(() => !!a.env, 2000, 'start');
    expect(new Set(room.game!.options.pool)).toEqual(new Set(ten));
    expect((await a.emit('room:settings', { augPool: 'all' })).ok).toBe(false);
    for (const p of room.game!.players) for (const id of p.pickOptions ?? []) expect(ten).toContain(id);
  });
});

describe('추방', () => {
  it('방장은 연결 끊긴 플레이어만 추방할 수 있고, 추방된 토큰은 다시 들어올 수 없다', async () => {
    const s = await start(false, 0.02);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    for (const cl of [a, b, c]) passive(cl);
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    await a.emit('room:settings', { autoKickMinutes: 0 });
    // 게임 전에는 추방 없음
    expect((await a.emit('room:kick', { playerId: b.id })).ok).toBe(false);
    await a.emit('room:start');
    await waitFor(() => !!a.env && !!c.env, 2000, 'start');
    const room = s.rooms.rooms.get(a.code)!;
    // 접속 중인 플레이어는 추방할 수 없고, 방장이 아니면 거부
    expect((await a.emit('room:kick', { playerId: b.id })).error).toContain('접속 중');
    b.sock.disconnect();
    await waitFor(() => a.env!.connected[b.id] === false, 2000, 'disconnect seen');
    expect((await c.emit('room:kick', { playerId: b.id })).error).toContain('방장');
    expect((await a.emit('room:kick', { playerId: b.id })).ok).toBe(true);
    await waitFor(() => a.env!.view.players.find((p) => p.id === b.id)?.kicked === true || !a.env!.view.players.some((p) => p.id === b.id), 2000, 'kicked shown');
    await waitFor(() => !room.game!.players.some((p) => p.id === b.id) || room.game!.phase === 'gameOver', 10000, 'removed after hand');
    expect(room.game!.log.some((e) => e.text.includes('B님이 추방되었습니다'))).toBe(true);
    // 같은 토큰으로 재접속·재입장 불가
    const r = await b.reconnect(s.port);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('추방');
    const r2 = await b.join(a.code, 'B2', b.token);
    expect(r2.ok).toBe(false);
  });

  it('자동 추방: 설정한 시간 이상 연결이 끊기면 추방되고 게임은 계속된다', async () => {
    const s = await start(false, 0.005); // 3분 → 0.9초
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    const c = new VClient(s.port);
    for (const cl of [a, b, c]) passive(cl);
    await a.create('A');
    await b.join(a.code, 'B');
    await c.join(a.code, 'C');
    await a.emit('room:settings', { autoKickMinutes: 3 });
    const room = s.rooms.rooms.get(a.code)!;
    await a.emit('room:start');
    await waitFor(() => !!room.game && room.game.handNumber >= 1 && room.game.phase === 'betting', 3000, 'start');
    b.sock.disconnect();
    await waitFor(() => room.game!.log.some((e) => e.text.includes('B님이 추방되었습니다')), 5000, 'auto kick');
    const hand = room.game!.handNumber;
    await waitFor(() => room.game!.handNumber > hand + 1 || room.game!.phase === 'gameOver', 10000, 'game continues');
    expect(room.game!.players.some((p) => p.id === b.id)).toBe(false);
  });
});

describe('중도 참여', () => {
  it('게임 중에 들어오면 관전하며 증강을 고르고, 다음 핸드부터 자리에 앉는다 (이전 비공개 정보 없음)', async () => {
    const s = await start(false, 0.02);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    for (const cl of [a, b]) passive(cl);
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:settings', { fillBots: true, botCount: 1, autoKickMinutes: 0, levelMode: 'fixed', levelHands: 4 });
    const room = s.rooms.rooms.get(a.code)!;
    const checked = watchRoom(room);
    await a.emit('room:start');
    await waitFor(() => !!room.game && room.game.handNumber >= 2 && room.game.phase === 'betting', 10000, 'hand 2');
    const c = new VClient(s.port);
    passive(c);
    let firstJoinEnv: GameEnvelope | null = null;
    c.sock.on('game', (e: GameEnvelope) => (firstJoinEnv ??= e));
    const r = await c.join(a.code, 'C');
    expect(r.ok).toBe(true);
    await waitFor(() => !!firstJoinEnv, 2000, 'joiner view');
    const v0 = firstJoinEnv!.view;
    expect(v0.you.seated).toBe(false);
    expect(v0.you.joining?.picksTotal).toBe(room.game!.pickRounds);
    expect(v0.log.some((x) => x.text.includes('핸드 #1'))).toBe(false);
    await waitFor(() => !!a.env!.view.joiners.find((j) => j.name === 'C') || a.env!.view.players.some((p) => p.name === 'C'), 3000, 'joiner shown to others');
    await waitFor(() => !!room.game!.players.find((p) => p.id === c.id), 20000, 'seated');
    const pc = room.game!.players.find((p) => p.id === c.id)!;
    expect(pc.augments.length).toBe(v0.you.joining!.picksTotal);
    expect(room.game!.log.some((e) => e.text.includes('C님이 참여했습니다'))).toBe(true);
    await waitFor(() => c.env?.view.you.seated === true && (c.env.view.you.hole.length > 0 || c.env.view.phase !== 'betting'), 5000, 'playing');
    expect(checked()).toBeGreaterThan(10);
  });
});

describe('채팅', () => {
  it('방 안의 모두에게 전달되고, 입력을 정리·제한하며, 새로 들어온 사람은 기록을 받는다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    const got: ChatMessage[] = [];
    b.sock.on('chat', (m: ChatMessage) => got.push(m));
    // 방에 들어가기 전에는 보낼 수 없다
    await a.ready();
    expect((await a.emit('chat:send', { text: 'hi' })).ok).toBe(false);
    await a.create('A');
    await b.join(a.code, 'B');
    expect((await a.emit('chat:send', { text: '  안녕 <b>hi</b>\n ' })).ok).toBe(true);
    await waitFor(() => got.length === 1, 2000, 'chat delivered');
    // 화면에서 이스케이프하므로 서버는 원문을 그대로 두되 제어 문자만 정리
    expect(got[0]).toMatchObject({ fromId: a.id, name: 'A', text: '안녕 <b>hi</b>' });
    expect((await a.emit('chat:send', { text: '   ' })).ok).toBe(false);
    expect((await a.emit('chat:send', { text: 123 })).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 320));
    expect((await b.emit('chat:send', { text: 'x'.repeat(500) })).ok).toBe(true);
    await waitFor(() => got.length === 2, 2000, 'long chat');
    expect(got[1].text).toHaveLength(200);
    // 도배 방지: 연속 전송 간격, 5초에 5개
    const r1 = await a.emit('chat:send', { text: '1' });
    expect(r1.ok).toBe(true);
    expect((await a.emit('chat:send', { text: '2' })).ok).toBe(false);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 320));
      expect((await a.emit('chat:send', { text: `ok${i}` })).ok).toBe(true);
    }
    await new Promise((r) => setTimeout(r, 320));
    const limited = await a.emit('chat:send', { text: 'too many' });
    expect(limited.ok).toBe(false);
    // 새로 들어온 사람은 지금까지의 기록을 받는다
    const c = new VClient(s.port);
    let history: ChatMessage[] = [];
    c.sock.on('chat:history', (list: ChatMessage[]) => (history = list));
    await c.join(a.code, 'C');
    await waitFor(() => history.length > 0, 2000, 'history');
    expect(history.map((m) => m.text)).toEqual(['안녕 <b>hi</b>', 'x'.repeat(200), '1', 'ok0', 'ok1', 'ok2']);
  });

  it('게임 중에도 채팅이 되고, 게임 화면 데이터와는 별도로 전달된다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    await waitFor(() => !!b.env, 2000, 'game');
    const got: ChatMessage[] = [];
    a.sock.on('chat', (m: ChatMessage) => got.push(m));
    expect((await b.emit('chat:send', { text: 'gg' })).ok).toBe(true);
    await waitFor(() => got.length === 1, 2000, 'chat in game');
    expect(got[0].name).toBe('B');
  });
});

describe('서버 측 검증과 디버그 차단', () => {
  it('잘못된 행동은 서버가 거부한다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    await waitFor(() => !!a.env?.view.you.pick && !!b.env?.view.you.pick, 2000, 'pick');
    // 선택지에 없는 증강
    const notOffered = ['seal', 'foresight', 'favoritism', 'observer'].find((id) => !a.env!.view.you.pick!.some((o) => o.id === id))!;
    expect((await a.emit('game:action', { type: 'pick', augment: notOffered })).ok).toBe(false);
    expect((await a.emit('game:action', { type: 'pick', augment: '<script>' })).ok).toBe(false);
    expect((await a.emit('game:action', 'fold')).ok).toBe(false);
    expect((await a.emit('game:action', { type: 'useAugment', augment: 'seal' })).ok).toBe(false);
    await a.emit('game:action', { type: 'pick', augment: a.env!.view.you.pick![0].id });
    await b.emit('game:action', { type: 'pick', augment: b.env!.view.you.pick![0].id });
    await waitFor(() => !!a.env?.view.you.legal || !!b.env?.view.you.legal, 2000, 'turn');
    const [turn, other] = a.env!.view.you.legal ? [a, b] : [b, a];
    expect((await other.emit('game:action', { type: 'call' })).ok).toBe(false); // 차례 아님
    expect((await turn.emit('game:action', { type: 'raise', amount: 1 })).ok).toBe(false); // 최소 레이즈 미만
    expect((await turn.emit('game:action', { type: 'raise', amount: 999999 })).ok).toBe(false); // 칩 초과
    expect((await turn.emit('game:action', { type: 'call' })).ok).toBe(true);
  });

  it('DEBUG 가 꺼져 있으면 디버그 이벤트 자체가 없다', async () => {
    const s = await start(false, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    let debugState = false;
    a.sock.on('debug:state', () => (debugState = true));
    for (const ev of ['debug:reveal', 'debug:give', 'debug:deal', 'debug:chips', 'debug:levelup', 'debug:disconnect']) {
      const r = await a.emit(ev, { on: true, playerId: a.id, augment: 'foresight', chips: 99999 }, 400);
      expect(r).toEqual({ ok: false, error: 'timeout' }); // 응답하는 핸들러가 없음
    }
    expect(debugState).toBe(false);
    expect(s.rooms.rooms.get(a.code)!.game!.options.debug).toBe(false);
    expect(a.env!.debug).toBe(false);
  });

  it('DEBUG 모드: 특정 플레이어의 연결을 끊은 상태로 만든다', async () => {
    const s = await start(true, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    await waitFor(() => !!a.env, 2000, 'start');
    expect((await a.emit('debug:disconnect', { playerId: b.id })).ok).toBe(true);
    await waitFor(() => a.env!.connected[b.id] === false, 2000, 'b disconnected');
    await waitFor(() => !b.sock.connected, 2000, 'b socket closed');
  });

  it('DEBUG 모드에서는 전체 공개·증강 지급·덱 지정이 동작한다', async () => {
    const s = await start(true, 1);
    const a = new VClient(s.port);
    const b = new VClient(s.port);
    a.auto = b.auto = false;
    await a.create('A');
    await b.join(a.code, 'B');
    await a.emit('room:start');
    await waitFor(() => !!a.env, 2000, 'game');
    let dbg: { players: { id: string; augments: { id: string }[] }[] } | null = null;
    a.sock.on('debug:state', (d) => (dbg = d));
    expect((await a.emit('debug:reveal', { on: true })).ok).toBe(true);
    expect((await a.emit('debug:give', { playerId: b.id, augment: 'foresight' })).ok).toBe(true);
    await waitFor(() => !!dbg && dbg.players.find((p) => p.id === b.id)!.augments.some((x) => x.id === 'foresight'), 2000, 'debug view');
    expect((await a.emit('debug:deal', { board: ['As', 'Ks', 'Qs', 'Js', 'Ts'], hands: { [a.id]: ['2c', '3c'] } })).ok).toBe(true);
    expect((await a.emit('debug:deal', { board: ['As', 'As'] })).ok).toBe(false);
    // 다른 사람(B)은 디버그 상태를 받지 않는다
    let bGot = false;
    b.sock.on('debug:state', () => (bGot = true));
    await a.emit('room:settings', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(bGot).toBe(false);
  });
});

describe('반응 대기 시간', () => {
  it('카운터 스펠 보유자가 있든 없든 선언에서 적용까지 같은 시간이 걸린다', async () => {
    const s = await start(true, 0.1); // 3초 → 300ms
    async function measure(withCounter: boolean): Promise<number> {
      const a = new VClient(s.port);
      const b = new VClient(s.port);
      a.auto = b.auto = false;
      await a.create('A');
      await b.join(a.code, 'B');
      await a.emit('room:start');
      await waitFor(() => !!a.env?.view.you.pick && !!b.env?.view.you.pick, 3000, 'pick');
      await a.emit('game:action', { type: 'pick', augment: a.env!.view.you.pick![0].id });
      await b.emit('game:action', { type: 'pick', augment: b.env!.view.you.pick![0].id });
      await waitFor(() => a.env?.view.phase === 'betting', 3000, 'deal');
      expect((await a.emit('debug:give', { playerId: a.id, augment: 'glassTable' })).ok).toBe(true);
      if (withCounter) {
        const r = await a.emit('debug:give', { playerId: b.id, augment: 'counterSpell' });
        if (!r.ok) expect(r.error).toContain('이미'); // 카운터형은 1개만
      }
      const t0 = Date.now();
      expect((await a.emit('game:action', { type: 'useAugment', augment: 'glassTable' })).ok).toBe(true);
      await waitFor(() => !!a.env?.view.table.glass, 3000, 'glass applied');
      return Date.now() - t0;
    }
    const plain = await measure(false);
    const counter = await measure(true);
    expect(plain).toBeGreaterThanOrEqual(280);
    expect(Math.abs(plain - counter)).toBeLessThan(150);
  });
});

describe('HTTP', () => {
  it('/health', async () => {
    const s = await start();
    const res = await fetch(`http://localhost:${s.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
