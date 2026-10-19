// 방 관리: 대기실, 접속/재접속, 게임 진행 타이머, 봇 실행, 플레이어별 뷰 전송.
// 게임 상태(GameState)는 이 파일 밖으로 나가지 않는다. 클라이언트에는 getPlayerView 결과만 보낸다.

import { randomBytes, randomInt } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  applyAction,
  applyTimeouts,
  chooseBotAction,
  chooseBotOpportunistic,
  counterCandidates,
  REACTION_MS,
  createGame,
  cryptoRng,
  defaultActionFor,
  getDebugView,
  getPending,
  getPlayerView,
  setSittingOut,
  startNextHand,
  type GameAction,
  type GameState,
  type PendingKind,
} from '../../engine/src/index.js';
import type { ChatMessage, GameEnvelope, LobbyState, RoomSettings } from './protocol.js';

export interface ServerOptions {
  /** DEBUG=true 일 때만 true. 디버그 이벤트 등록과 엔진 디버그 기능을 모두 좌우한다. */
  debug: boolean;
  /** 핸드 종료 후 결과를 보여 주는 시간 */
  handEndDelayMs: number;
  botDelayMs: [number, number];
  pickSeconds: number;
  /** 자리 비움 플레이어 자동 행동까지의 지연 */
  sitOutDelayMs: number;
  /** 모두 나간 방을 지우기까지 */
  emptyRoomTtlMs: number;
  /** 테스트용: 모든 시간에 곱하는 배율 */
  timeScale: number;
}

export const DEFAULT_OPTIONS: ServerOptions = {
  debug: false,
  handEndDelayMs: 5000,
  botDelayMs: [1000, 2000],
  pickSeconds: 30,
  sitOutDelayMs: 500,
  emptyRoomTtlMs: 10 * 60 * 1000,
  timeScale: 1,
};

export const DEFAULT_SETTINGS: RoomSettings = { maxPlayers: 8, fillBots: false, botCount: 0, turnSeconds: 30 };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 O/0/I/1 제외
export const CODE_RE = /^[A-Z0-9]{5}$/;

export interface Member {
  id: string;
  token: string;
  name: string;
  isBot: boolean;
  socketId: string | null;
  connected: boolean;
  /** 게임 중 '나가기'를 누른 사람 */
  left: boolean;
  absentStreak: number;
}

export const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 100;
/** 도배 방지: 5초에 5개까지, 연속 전송은 0.3초 간격 */
const CHAT_WINDOW_MS = 5000;
const CHAT_WINDOW_MAX = 5;
const CHAT_MIN_GAP_MS = 300;

export function sanitizeChat(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  return text.length ? text : null;
}

export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return name.length ? name : null;
}

export class Room {
  readonly code: string;
  hostId = '';
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  members: Member[] = [];
  game: GameState | null = null;
  deleted = false;

  private lastSeq = -1;
  private absenceHand = -1;
  private statsPrinted = false;
  private deadline: number | null = null;
  private deadlineKind: PendingKind | null = null;
  private decisionTimer: NodeJS.Timeout | null = null;
  private autoTimers = new Map<string, NodeJS.Timeout>();
  private deleteTimer: NodeJS.Timeout | null = null;
  readonly debugReveal = new Set<string>();
  readonly chat: ChatMessage[] = [];
  private chatSeq = 0;
  private chatTimes = new Map<string, number[]>();

  constructor(
    code: string,
    private readonly io: Server,
    private readonly opts: ServerOptions,
    private readonly onDelete: (room: Room) => void,
  ) {
    this.code = code;
  }

  get started(): boolean {
    return this.game !== null;
  }

  member(id: string): Member | undefined {
    return this.members.find((m) => m.id === id);
  }

  humans(): Member[] {
    return this.members.filter((m) => !m.isBot);
  }

  private ms(base: number): number {
    return Math.max(1, Math.round(base * this.opts.timeScale));
  }

  addHuman(name: string): Member {
    let unique = name;
    for (let k = 2; this.members.some((m) => m.name === unique); k++) unique = `${name}(${k})`;
    const m: Member = {
      id: 'u_' + randomBytes(5).toString('hex'),
      token: randomBytes(24).toString('base64url'),
      name: unique,
      isBot: false,
      socketId: null,
      connected: false,
      left: false,
      absentStreak: 0,
    };
    this.members.push(m);
    if (!this.hostId) this.hostId = m.id;
    return m;
  }

  // ───────── 접속 상태 ─────────

  attach(m: Member, socketId: string): void {
    m.socketId = socketId;
    m.connected = true;
    m.absentStreak = 0;
    if (this.game && !m.left) setSittingOut(this.game, m.id, false);
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
    // 방장이 없거나(모두 나갔다 돌아옴) 방장이 끊겨 있으면 접속한 사람이 이어받는다
    const host = this.member(this.hostId);
    if (!host || !host.connected || host.left) this.hostId = m.id;
  }

  detach(m: Member): void {
    m.socketId = null;
    m.connected = false;
    this.debugReveal.delete(m.id);
    if (m.id === this.hostId) this.transferHost(m);
    this.checkEmpty();
  }

  /** 방장이 나가면 다음 순서의 (접속 중인) 플레이어에게 */
  private transferHost(from: Member): void {
    const humans = this.humans();
    const start = humans.indexOf(from);
    for (let k = 1; k <= humans.length; k++) {
      const cand = humans[(start + k) % humans.length];
      if (cand && cand !== from && cand.connected && !cand.left) {
        this.hostId = cand.id;
        return;
      }
    }
  }

  leave(m: Member): void {
    if (!this.game) {
      this.members = this.members.filter((x) => x !== m);
      if (m.id === this.hostId) {
        this.hostId = '';
        const next = this.humans().find((x) => x.connected) ?? this.humans()[0];
        if (next) this.hostId = next.id;
      }
    } else {
      m.left = true;
      setSittingOut(this.game, m.id, true);
    }
    m.socketId = null;
    m.connected = false;
    if (m.id === this.hostId) this.transferHost(m);
    this.debugReveal.delete(m.id);
    this.checkEmpty();
  }

  private checkEmpty(): void {
    if (this.humans().some((m) => m.connected)) return;
    if (this.deleteTimer) return;
    this.deleteTimer = setTimeout(() => this.destroy(), this.ms(this.opts.emptyRoomTtlMs));
  }

  destroy(): void {
    if (this.deleted) return;
    this.deleted = true;
    this.clearTimers();
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.onDelete(this);
  }

  private clearTimers(): void {
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    this.decisionTimer = null;
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
    this.deadline = null;
    this.deadlineKind = null;
  }

  // ───────── 대기실 ─────────

  updateSettings(by: Member, patch: Partial<RoomSettings>): string | null {
    if (by.id !== this.hostId) return '방장만 설정을 바꿀 수 있습니다.';
    if (this.game) return '게임이 이미 시작되었습니다.';
    const s = { ...this.settings };
    const int = (v: unknown, lo: number, hi: number) =>
      typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
    if (patch.maxPlayers !== undefined) {
      const v = int(patch.maxPlayers, 2, 8);
      if (v === null) return '최대 인원은 2~8명입니다.';
      if (v < this.humans().length) return '현재 인원보다 적게 설정할 수 없습니다.';
      s.maxPlayers = v;
    }
    if (patch.fillBots !== undefined) {
      if (typeof patch.fillBots !== 'boolean') return '잘못된 값입니다.';
      s.fillBots = patch.fillBots;
    }
    if (patch.botCount !== undefined) {
      const v = int(patch.botCount, 0, 7);
      if (v === null) return '봇 수는 0~7명입니다.';
      s.botCount = v;
    }
    if (patch.turnSeconds !== undefined) {
      const v = int(patch.turnSeconds, 5, 120);
      if (v === null) return '행동 제한 시간은 5~120초입니다.';
      s.turnSeconds = v;
    }
    s.botCount = Math.min(s.botCount, s.maxPlayers - this.humans().length);
    this.settings = s;
    return null;
  }

  canJoin(): string | null {
    if (this.game) return '이미 게임이 시작된 방입니다.';
    if (this.humans().length >= this.settings.maxPlayers) return '방이 가득 찼습니다.';
    return null;
  }

  start(by: Member): string | null {
    if (by.id !== this.hostId) return '방장만 시작할 수 있습니다.';
    if (this.game) return '이미 시작되었습니다.';
    const humans = this.humans().filter((m) => !m.left);
    const bots = this.settings.fillBots ? Math.max(0, Math.min(this.settings.botCount, this.settings.maxPlayers - humans.length)) : 0;
    if (humans.length + bots < 2) return '2명 이상이어야 시작할 수 있습니다. (봇으로 채우기를 켜 보세요)';
    if (humans.length + bots > 8) return '최대 8명입니다.';
    for (let i = 0; i < bots; i++) {
      this.members.push({
        id: 'b_' + randomBytes(4).toString('hex'),
        token: '',
        name: `봇 ${i + 1}`,
        isBot: true,
        socketId: null,
        connected: true,
        left: false,
        absentStreak: 0,
      });
    }
    this.game = createGame(
      this.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot })),
      { debug: this.opts.debug, rng: cryptoRng },
    );
    for (const m of this.humans()) if (!m.connected) m.absentStreak = 0;
    this.lastSeq = -1;
    this.absenceHand = -1;
    this.statsPrinted = false;
    return null;
  }

  /** 채팅: 검증 후 기록하고 방 안의 접속자 모두에게 전송 (채팅은 공개 정보) */
  sendChat(m: Member, raw: unknown): string | null {
    if (m.isBot || m.left) return '채팅할 수 없습니다.';
    const text = sanitizeChat(raw);
    if (!text) return '메시지를 입력하세요.';
    const now = Date.now();
    const times = (this.chatTimes.get(m.id) ?? []).filter((t) => now - t < this.ms(CHAT_WINDOW_MS));
    if (times.length && now - times[times.length - 1] < this.ms(CHAT_MIN_GAP_MS)) return '너무 빨리 보내고 있습니다.';
    if (times.length >= CHAT_WINDOW_MAX) return '잠시 후 다시 보내 주세요.';
    times.push(now);
    this.chatTimes.set(m.id, times);
    const msg: ChatMessage = { id: ++this.chatSeq, fromId: m.id, name: m.name, text, ts: now };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    for (const x of this.humans()) {
      if (x.socketId) this.io.sockets.sockets.get(x.socketId)?.emit('chat', msg);
    }
    return null;
  }

  /** 게임 종료 후 같은 사람들로 대기실로 */
  backToLobby(by: Member): string | null {
    if (by.id !== this.hostId) return '방장만 할 수 있습니다.';
    if (!this.game || this.game.phase !== 'gameOver') return '게임이 끝난 뒤에만 할 수 있습니다.';
    this.clearTimers();
    this.game = null;
    this.members = this.members.filter((m) => !m.isBot && !m.left);
    this.debugReveal.clear();
    return null;
  }

  // ───────── 게임 진행 ─────────

  act(m: Member, action: GameAction): string | null {
    if (!this.game) return '게임이 시작되지 않았습니다.';
    if (m.left) return '방을 나간 플레이어입니다.';
    let r;
    try {
      r = applyAction(this.game, m.id, action);
    } catch (e) {
      console.error('[action error]', e);
      return '처리 중 오류가 발생했습니다.';
    }
    if (!r.ok) return r.error;
    return null;
  }

  /** 상태가 바뀔 때마다 호출: 타이머 갱신, 봇/자리 비움 자동 행동 예약, 각자에게 뷰 전송 */
  sync(): void {
    if (this.deleted) return;
    const g = this.game;
    if (g) {
      const pending = getPending(g);
      if (pending.seq !== this.lastSeq) {
        this.lastSeq = pending.seq;
        this.onNewDecision(pending.kind, pending.seq);
      }
      this.scheduleAutomatic(pending.playerIds);
      this.scheduleBotExtras(pending.kind, pending.seq, pending.playerIds);
      if (g.phase === 'gameOver' && !this.statsPrinted) {
        this.statsPrinted = true;
        this.printStats();
      }
    }
    this.broadcast();
  }

  /** 봇: 반응 대기 중 카운터 스펠, 차례가 아닐 때 쓰는 증강 (결정 상황이 바뀔 때마다 한 번) */
  private scheduleBotExtras(kind: PendingKind, seq: number, pendingIds: string[]): void {
    const g = this.game!;
    const bots = this.members.filter((m) => m.isBot && !g.players.find((p) => p.id === m.id)?.out);
    const schedule = (key: string, delay: number, fn: () => void) => {
      if (this.autoTimers.has(key)) return;
      this.autoTimers.set(
        key,
        setTimeout(() => {
          this.autoTimers.delete(key);
          if (this.game === g && !this.deleted) fn();
        }, this.ms(delay)),
      );
    };
    if (kind === 'reaction') {
      for (const id of counterCandidates(g)) {
        if (!bots.some((b) => b.id === id)) continue;
        schedule(`counter:${seq}:${id}`, 300 + Math.random() * 1500, () => {
          if (getPending(g).seq !== seq) return;
          const a = chooseBotAction(getPlayerView(g, id), cryptoRng);
          if (a?.type === 'counter' && applyAction(g, id, a).ok) this.sync();
        });
      }
      return;
    }
    const [lo, hi] = this.opts.botDelayMs;
    for (const b of bots) {
      if (pendingIds.includes(b.id)) continue;
      schedule(`opp:${seq}:${b.id}`, lo + Math.random() * (hi - lo), () => {
        if (getPending(g).seq !== seq) return;
        const a = chooseBotOpportunistic(getPlayerView(g, b.id), cryptoRng);
        if (a && applyAction(g, b.id, a).ok) this.sync();
      });
    }
  }

  /** 게임 종료 통계 (밸런스 확인용, 서버 콘솔) */
  private printStats(): void {
    const g = this.game!;
    const st = g.stats;
    const ids = [...new Set([...Object.keys(st.picks), ...Object.keys(st.uses)])] as (keyof typeof st.picks)[];
    const rows = ids
      .map((id) => ({ 증강: id, 선택: st.picks[id] ?? 0, 사용: st.uses[id] ?? 0 }))
      .sort((a, b) => b.선택 - a.선택);
    console.log(`\n[게임 종료 통계] 방 ${this.code} · 총 핸드 ${g.handNumber} · 은행 생성 칩 ${st.bankChips} · 세금으로 사라진 칩 ${st.bankTaxed}`);
    console.table(rows);
  }

  private onNewDecision(kind: PendingKind, seq: number): void {
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    this.decisionTimer = null;
    this.deadline = null;
    this.deadlineKind = null;
    let base: number;
    switch (kind) {
      case 'turn':
      case 'discard':
      case 'declare':
        base = this.settings.turnSeconds * 1000;
        break;
      case 'reaction':
        // 카운터 스펠 보유 여부와 관계없이 항상 같은 3초 (대기 여부로 보유자가 드러나지 않게)
        base = REACTION_MS;
        break;
      case 'pick':
        base = this.opts.pickSeconds * 1000;
        break;
      case 'handEnd':
        this.accountAbsence();
        base = this.opts.handEndDelayMs + (this.game?.result?.showdown ? 2000 : 0);
        break;
      default:
        return;
    }
    const ms = this.ms(base);
    this.deadline = Date.now() + ms;
    this.deadlineKind = kind;
    this.decisionTimer = setTimeout(() => this.onDeadline(seq), ms);
  }

  private onDeadline(seq: number): void {
    const g = this.game;
    if (!g || this.deleted) return;
    const pending = getPending(g);
    if (pending.seq !== seq) return;
    try {
      if (pending.kind === 'handEnd') startNextHand(g);
      else applyTimeouts(g);
    } catch (e) {
      console.error('[timeout error]', e);
    }
    this.sync();
  }

  /** 핸드가 끝날 때마다: 연결이 끊긴 채 3핸드 연속이면 자리 비움 */
  private accountAbsence(): void {
    const g = this.game;
    if (!g || this.absenceHand === g.handNumber) return;
    this.absenceHand = g.handNumber;
    for (const m of this.humans()) {
      m.absentStreak = m.connected ? 0 : m.absentStreak + 1;
      if (m.left || m.absentStreak >= 3) setSittingOut(g, m.id, true);
    }
  }

  private scheduleAutomatic(playerIds: string[]): void {
    const g = this.game!;
    for (const id of playerIds) {
      if (this.autoTimers.has(id)) continue;
      const m = this.member(id);
      const p = g.players.find((x) => x.id === id);
      if (!m || !p) continue;
      let delay: number;
      if (m.isBot) {
        const [lo, hi] = this.opts.botDelayMs;
        delay = lo + Math.random() * (hi - lo);
      } else if (p.sittingOut) {
        delay = this.opts.sitOutDelayMs;
      } else continue;
      this.autoTimers.set(
        id,
        setTimeout(() => {
          this.autoTimers.delete(id);
          this.runAutomatic(id);
        }, this.ms(delay)),
      );
    }
  }

  private runAutomatic(id: string): void {
    const g = this.game;
    if (!g || this.deleted) return;
    if (!getPending(g).playerIds.includes(id)) return;
    const m = this.member(id)!;
    try {
      let action: GameAction | null = null;
      if (m.isBot) {
        // 봇도 사람과 똑같이 자기 뷰만 보고 결정한다
        action = chooseBotAction(getPlayerView(g, id), cryptoRng);
      } else {
        action = defaultActionFor(g, id);
      }
      const r = action ? applyAction(g, id, action) : { ok: false as const, error: 'no action' };
      if (!r.ok) {
        const d = defaultActionFor(g, id);
        if (d) applyAction(g, id, d);
      }
    } catch (e) {
      console.error('[auto action error]', e);
      const d = defaultActionFor(g, id);
      if (d) applyAction(g, id, d);
    }
    this.sync();
  }

  // ───────── 전송 ─────────

  lobbyState(forId: string): LobbyState {
    return {
      code: this.code,
      youId: forId,
      hostId: this.hostId,
      settings: { ...this.settings },
      players: this.humans().map((m) => ({ id: m.id, name: m.name, connected: m.connected, isHost: m.id === this.hostId })),
      debug: this.opts.debug,
    };
  }

  envelope(forId: string): GameEnvelope {
    const g = this.game!;
    const view = getPlayerView(g, forId);
    for (const pv of view.players) {
      const mm = this.member(pv.id);
      pv.connected = !!mm && (mm.isBot || mm.connected);
      pv.isHost = pv.id === this.hostId;
    }
    return {
      code: this.code,
      view,
      deadline: this.deadline,
      deadlineKind: this.deadlineKind,
      serverNow: Date.now(),
      youAreHost: forId === this.hostId,
      debug: this.opts.debug,
    };
  }

  /** 각 사람에게 그 사람의 뷰만 개별 전송 (모두에게 같은 데이터를 뿌리지 않는다) */
  broadcast(): void {
    for (const m of this.members) {
      if (m.isBot || !m.socketId) continue;
      const sock = this.io.sockets.sockets.get(m.socketId);
      if (!sock) continue;
      if (this.game) {
        sock.emit('game', this.envelope(m.id));
        if (this.opts.debug && this.debugReveal.has(m.id)) sock.emit('debug:state', getDebugView(this.game));
      } else {
        sock.emit('lobby', this.lobbyState(m.id));
      }
    }
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly tokens = new Map<string, { code: string; memberId: string }>();

  constructor(
    private readonly io: Server,
    readonly opts: ServerOptions,
  ) {}

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(hostName: string): { room: Room; member: Member } {
    const room = new Room(this.newCode(), this.io, this.opts, (r) => {
      this.rooms.delete(r.code);
      for (const [t, v] of this.tokens) if (v.code === r.code) this.tokens.delete(t);
    });
    this.rooms.set(room.code, room);
    const member = room.addHuman(hostName);
    this.tokens.set(member.token, { code: room.code, memberId: member.id });
    return { room, member };
  }

  join(code: string, name: string): { room: Room; member: Member } | string {
    const room = this.rooms.get(code);
    if (!room) return '방을 찾을 수 없습니다.';
    const err = room.canJoin();
    if (err) return err;
    const member = room.addHuman(name);
    this.tokens.set(member.token, { code: room.code, memberId: member.id });
    return { room, member };
  }

  byToken(token: unknown): { room: Room; member: Member } | null {
    if (typeof token !== 'string') return null;
    const t = this.tokens.get(token);
    if (!t) return null;
    const room = this.rooms.get(t.code);
    const member = room?.member(t.memberId);
    if (!room || !member) {
      this.tokens.delete(token);
      return null;
    }
    return { room, member };
  }

  forgetToken(token: string): void {
    this.tokens.delete(token);
  }

  shutdown(): void {
    for (const r of [...this.rooms.values()]) r.destroy();
  }
}
