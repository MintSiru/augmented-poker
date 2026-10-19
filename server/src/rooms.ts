// 방 관리: 대기실, 접속/재접속, 게임 진행 타이머, 봇 실행, 플레이어별 뷰 전송.
// 게임 상태(GameState)는 이 파일 밖으로 나가지 않는다. 클라이언트에는 getPlayerView 결과만 보낸다.

import { randomBytes, randomInt } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  addJoiner,
  applyAction,
  applyTimeouts,
  blindsAt,
  getJoiner,
  joinerPending,
  joinerTimeout,
  kickPlayer,
  removeJoiner,
  setLevelPlan,
  turnSecondsFor,
  chooseBotAction,
  chooseBotOpportunistic,
  counterCandidates,
  immunityCandidates,
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
import { AUTO_KICK_CHOICES, IN_GAME_SETTINGS, type ChatMessage, type GameEnvelope, type LobbyState, type RoomListItem, type RoomSettings } from './protocol.js';

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
  /** 동시에 존재할 수 있는 방 수 (서버 메모리 보호) */
  maxRooms: number;
}

export const DEFAULT_OPTIONS: ServerOptions = {
  debug: false,
  handEndDelayMs: 5000,
  botDelayMs: [1000, 2000],
  pickSeconds: 30,
  sitOutDelayMs: 500,
  emptyRoomTtlMs: 10 * 60 * 1000,
  timeScale: 1,
  maxRooms: 50,
};

export const DEFAULT_SETTINGS: RoomSettings = {
  maxPlayers: 8,
  fillBots: false,
  botCount: 0,
  turnSeconds: 30,
  startingChips: 1000,
  bigBlind: 20,
  levelMode: 'auto',
  levelHands: 10,
  blindSchedule: 'standard',
  midJoin: true,
  autoKickMinutes: 5,
};

export const ROOM_NAME_MAX = 20;

export function sanitizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, ROOM_NAME_MAX);
  return name.length ? name : null;
}

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
  /** 추방됨 (토큰 무효) */
  kicked: boolean;
  /** 연결이 끊긴 시각 (자동 추방 기준) */
  disconnectedAt: number | null;
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
  name = '';
  isPublic = true;
  hostId = '';
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  /** 추방된 플레이어의 토큰 (이 방에 다시 들어올 수 없음) */
  readonly revokedTokens = new Set<string>();
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
  private kickTimers = new Map<string, NodeJS.Timeout>();
  private joinerTimers = new Map<string, NodeJS.Timeout>();
  private joinerDeadlines = new Map<string, number>();
  readonly debugReveal = new Set<string>();
  readonly chat: ChatMessage[] = [];
  private chatSeq = 0;
  private chatTimes = new Map<string, number[]>();

  constructor(
    code: string,
    private readonly io: Server,
    private readonly opts: ServerOptions,
    private readonly onDelete: (room: Room) => void,
    /** 공개 방 목록이 바뀌었을 수 있음 */
    private readonly onChange: () => void = () => {},
    /** 추방된 플레이어의 토큰 무효화 */
    private readonly onRevoke: (token: string) => void = () => {},
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
    return this.members.filter((m) => !m.isBot && !m.kicked);
  }

  /** 게임 중 자리를 차지하고 있는 수 (살아 있는 플레이어 + 중도 참여 대기자) */
  occupied(): number {
    const g = this.game;
    if (!g) return this.humans().length;
    return g.players.filter((p) => !p.out && !p.kicked).length + g.joiners.length;
  }

  /** 공개 방 목록의 한 줄 (게임 내용은 포함하지 않는다) */
  listItem(): RoomListItem {
    const s = this.settings;
    const { sb, bb } = blindsAt(0, s.bigBlind, s.blindSchedule);
    return {
      code: this.code,
      name: this.name,
      players: this.occupied(),
      maxPlayers: s.maxPlayers,
      status: this.game && this.game.phase !== 'gameOver' ? 'playing' : 'waiting',
      midJoin: s.midJoin,
      joinable: this.canJoin() === null,
      startingChips: s.startingChips,
      smallBlind: sb,
      bigBlind: bb,
    };
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
      kicked: false,
      disconnectedAt: null,
    };
    this.members.push(m);
    if (!this.hostId) this.hostId = m.id;
    return m;
  }

  /** 입장: 대기 중이면 대기실로, 게임 중이면 중도 참여(관전하며 증강을 고른 뒤 다음 핸드부터) */
  addMember(name: string): Member | string {
    const err = this.canJoin();
    if (err) return err;
    const m = this.addHuman(name);
    if (this.game) {
      const r = addJoiner(this.game, { id: m.id, name: m.name, isBot: false });
      if (!r.ok) {
        this.members = this.members.filter((x) => x !== m);
        return r.error;
      }
    }
    return m;
  }

  // ───────── 접속 상태 ─────────

  attach(m: Member, socketId: string): void {
    m.socketId = socketId;
    m.connected = true;
    m.absentStreak = 0;
    m.disconnectedAt = null;
    this.clearKickTimer(m);
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
    m.disconnectedAt = Date.now();
    this.debugReveal.delete(m.id);
    if (m.id === this.hostId) this.transferHost(m);
    this.scheduleAutoKick(m);
    this.checkEmpty();
  }

  // ───────── 추방 ─────────

  private clearKickTimer(m: Member): void {
    const t = this.kickTimers.get(m.id);
    if (t) clearTimeout(t);
    this.kickTimers.delete(m.id);
  }

  /** 자동 추방: 설정한 시간 이상 연결이 끊긴 플레이어 (게임 중에만) */
  private scheduleAutoKick(m: Member): void {
    this.clearKickTimer(m);
    const min = this.settings.autoKickMinutes;
    if (!this.game || !min || m.isBot || m.kicked || m.connected || m.disconnectedAt === null) return;
    const wait = Math.max(0, this.ms(min * 60_000) - (Date.now() - m.disconnectedAt));
    this.kickTimers.set(
      m.id,
      setTimeout(() => {
        this.kickTimers.delete(m.id);
        if (this.deleted || m.connected || m.kicked || !this.game) return;
        if (this.doKick(m, '연결이 오래 끊겨 자동으로 추방되었습니다.') === null) this.sync();
      }, wait),
    );
  }

  private rescheduleAutoKicks(): void {
    for (const m of this.humans()) if (!m.connected) this.scheduleAutoKick(m);
  }

  /** 방장의 추방 요청: 연결이 끊겼거나 자리 비움 상태인 플레이어만 (접속 중인 플레이어는 추방할 수 없다) */
  kick(by: Member, targetId: unknown): string | null {
    if (by.id !== this.hostId) return '방장만 추방할 수 있습니다.';
    if (!this.game) return '게임 중에만 추방할 수 있습니다.';
    const t = typeof targetId === 'string' ? this.member(targetId) : undefined;
    if (!t || t.kicked) return '추방할 플레이어를 찾을 수 없습니다.';
    if (t.isBot) return '봇은 추방할 수 없습니다.';
    if (t.id === by.id) return '자기 자신은 추방할 수 없습니다.';
    if (t.connected) return '접속 중인 플레이어는 추방할 수 없습니다.';
    return this.doKick(t, '방장이 추방했습니다.');
  }

  private doKick(t: Member, reason: string): string | null {
    const g = this.game!;
    const r = kickPlayer(g, t.id);
    if (!r.ok) return r.error;
    t.kicked = true;
    t.left = true;
    this.clearKickTimer(t);
    this.revokedTokens.add(t.token);
    this.onRevoke(t.token);
    if (t.socketId) {
      const sock = this.io.sockets.sockets.get(t.socketId);
      sock?.emit('kicked', reason);
      t.socketId = null;
      t.connected = false;
    }
    // 앉기 전의 중도 참여자는 기록을 남길 필요가 없다
    if (!g.players.some((p) => p.id === t.id)) this.members = this.members.filter((x) => x !== t);
    return null;
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
    if (this.game && getJoiner(this.game, m.id)) {
      // 앉기 전에 나간 중도 참여자는 흔적 없이 뺀다
      removeJoiner(this.game, m.id);
      this.members = this.members.filter((x) => x !== m);
    } else if (!this.game) {
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
    m.disconnectedAt = Date.now();
    if (m.id === this.hostId) this.transferHost(m);
    this.debugReveal.delete(m.id);
    if (this.members.includes(m)) this.scheduleAutoKick(m);
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
    for (const t of this.kickTimers.values()) clearTimeout(t);
    this.kickTimers.clear();
    for (const t of this.joinerTimers.values()) clearTimeout(t);
    this.joinerTimers.clear();
    this.joinerDeadlines.clear();
    this.deadline = null;
    this.deadlineKind = null;
  }

  // ───────── 대기실 ─────────

  /** 방장 설정 변경. 게임이 시작된 뒤에는 최대 인원·제한 시간·중도 참여·자동 추방·상승 주기·공개 여부만 바꿀 수 있다 */
  updateSettings(by: Member, patch: Record<string, unknown>): string | null {
    if (by.id !== this.hostId) return '방장만 설정을 바꿀 수 있습니다.';
    const s = { ...this.settings };
    const int = (v: unknown, lo: number, hi: number) =>
      typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
    const keys = Object.keys(patch);
    if (this.game) {
      const locked = keys.filter((k) => k !== 'isPublic' && k !== 'name' && !IN_GAME_SETTINGS.includes(k as keyof RoomSettings));
      if (locked.length) return '게임이 시작된 뒤에는 칩과 블라인드 설정을 바꿀 수 없습니다.';
    }
    let name = this.name;
    let isPublic = this.isPublic;
    if (patch.name !== undefined) {
      const v = sanitizeRoomName(patch.name);
      if (!v) return `방 이름은 1~${ROOM_NAME_MAX}자입니다.`;
      name = v;
    }
    if (patch.isPublic !== undefined) {
      if (typeof patch.isPublic !== 'boolean') return '잘못된 값입니다.';
      isPublic = patch.isPublic;
    }
    if (patch.maxPlayers !== undefined) {
      const v = int(patch.maxPlayers, 2, 8);
      if (v === null) return '최대 인원은 2~8명입니다.';
      if (!this.game && v < this.humans().length) return '현재 인원보다 적게 설정할 수 없습니다.';
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
      const v = int(patch.turnSeconds, 15, 60);
      if (v === null) return '행동 제한 시간은 15~60초입니다.';
      s.turnSeconds = v;
    }
    if (patch.startingChips !== undefined) {
      const v = int(patch.startingChips, 200, 10000);
      if (v === null) return '시작 칩은 200~10,000입니다.';
      s.startingChips = v;
    }
    if (patch.bigBlind !== undefined) {
      const v = int(patch.bigBlind, 2, 1000);
      if (v === null) return '빅블라인드는 2~1,000입니다.';
      s.bigBlind = v;
    }
    if (patch.levelMode !== undefined) {
      if (patch.levelMode !== 'auto' && patch.levelMode !== 'fixed') return '잘못된 값입니다.';
      s.levelMode = patch.levelMode;
    }
    if (patch.levelHands !== undefined) {
      const v = int(patch.levelHands, 4, 30);
      if (v === null) return '블라인드 상승 주기는 4~30핸드입니다.';
      s.levelHands = v;
    }
    if (patch.blindSchedule !== undefined) {
      if (patch.blindSchedule !== 'standard' && patch.blindSchedule !== 'x1.5') return '잘못된 값입니다.';
      s.blindSchedule = patch.blindSchedule;
    }
    if (patch.midJoin !== undefined) {
      if (typeof patch.midJoin !== 'boolean') return '잘못된 값입니다.';
      s.midJoin = patch.midJoin;
    }
    if (patch.autoKickMinutes !== undefined) {
      if (!(AUTO_KICK_CHOICES as readonly unknown[]).includes(patch.autoKickMinutes)) return '자동 추방은 끄기/3분/5분/10분 중에서 고르세요.';
      s.autoKickMinutes = patch.autoKickMinutes as number;
    }
    if (!this.game) s.botCount = Math.min(s.botCount, s.maxPlayers - this.humans().length);
    const kickChanged = s.autoKickMinutes !== this.settings.autoKickMinutes;
    this.settings = s;
    this.name = name;
    this.isPublic = isPublic;
    if (this.game) {
      setLevelPlan(this.game, s.levelMode, s.levelHands);
      if (kickChanged) this.rescheduleAutoKicks();
    }
    return null;
  }

  canJoin(): string | null {
    const g = this.game;
    if (g) {
      if (g.phase === 'gameOver') return '게임이 끝난 방입니다. 방장이 대기실로 돌아가면 입장할 수 있습니다.';
      if (!this.settings.midJoin) return '이미 게임이 시작된 방입니다 (중도 참여 꺼짐).';
    }
    if (this.occupied() >= this.settings.maxPlayers) return '방이 가득 찼습니다.';
    return null;
  }

  /** 시작 칩이 BB 의 몇 배인가 (10BB 미만이면 시작할 수 없다) */
  startingBB(): number {
    return this.settings.startingChips / this.settings.bigBlind;
  }

  start(by: Member): string | null {
    if (by.id !== this.hostId) return '방장만 시작할 수 있습니다.';
    if (this.game) return '이미 시작되었습니다.';
    const humans = this.humans().filter((m) => !m.left);
    const bots = this.settings.fillBots ? Math.max(0, Math.min(this.settings.botCount, this.settings.maxPlayers - humans.length)) : 0;
    if (humans.length + bots < 2) return '2명 이상이어야 시작할 수 있습니다. (봇으로 채우기를 켜 보세요)';
    if (humans.length + bots > 8) return '최대 8명입니다.';
    if (this.startingBB() < 10) return `시작 칩이 ${Math.floor(this.startingBB())}BB 입니다. 10BB 이상이어야 시작할 수 있습니다.`;
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
        kicked: false,
        disconnectedAt: null,
      });
    }
    const s = this.settings;
    this.game = createGame(
      this.members.map((m) => ({ id: m.id, name: m.name, isBot: m.isBot })),
      {
        debug: this.opts.debug,
        rng: cryptoRng,
        startingChips: s.startingChips,
        bigBlind: s.bigBlind,
        blindSchedule: s.blindSchedule,
        levelMode: s.levelMode,
        fixedLevelHands: s.levelHands,
      },
    );
    for (const m of this.humans()) if (!m.connected) m.absentStreak = 0;
    this.rescheduleAutoKicks();
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
    this.members = this.members.filter((m) => !m.isBot && !m.left && !m.kicked);
    this.debugReveal.clear();
    return null;
  }

  // ───────── 게임 진행 ─────────

  act(m: Member, action: GameAction): string | null {
    if (!this.game) return '게임이 시작되지 않았습니다.';
    if (m.left || m.kicked) return '방을 나간 플레이어입니다.';
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
      this.scheduleJoinerPicks();
      if (g.phase === 'gameOver' && !this.statsPrinted) {
        this.statsPrinted = true;
        this.printStats();
      }
    }
    this.broadcast();
    this.onChange();
  }

  /** 중도 참여자의 연속 증강 선택: 선택 하나마다 30초 제한 시간 (각자 따로) */
  private scheduleJoinerPicks(): void {
    const g = this.game!;
    const live = new Set<string>();
    for (const { id, seq } of joinerPending(g)) {
      const key = `${id}:${seq}`;
      live.add(key);
      if (this.joinerTimers.has(key)) continue;
      const ms = this.ms(this.opts.pickSeconds * 1000);
      this.joinerDeadlines.set(id, Date.now() + ms);
      this.joinerTimers.set(
        key,
        setTimeout(() => {
          this.joinerTimers.delete(key);
          if (this.game !== g || this.deleted) return;
          const j = getJoiner(g, id);
          if (!j || j.pickSeq !== seq) return;
          joinerTimeout(g, id);
          this.sync();
        }, ms),
      );
    }
    for (const [key, t] of this.joinerTimers) {
      if (live.has(key)) continue;
      clearTimeout(t);
      this.joinerTimers.delete(key);
    }
    for (const id of [...this.joinerDeadlines.keys()]) {
      if (![...live].some((k) => k.startsWith(`${id}:`))) this.joinerDeadlines.delete(id);
    }
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
      for (const id of new Set([...counterCandidates(g), ...immunityCandidates(g)])) {
        if (!bots.some((b) => b.id === id)) continue;
        schedule(`counter:${seq}:${id}`, 300 + Math.random() * 1500, () => {
          if (getPending(g).seq !== seq) return;
          const a = chooseBotAction(getPlayerView(g, id), cryptoRng);
          if ((a?.type === 'counter' || a?.type === 'immunity') && applyAction(g, id, a).ok) this.sync();
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
    console.log(
      `\n[게임 종료 통계] 방 ${this.code} · 총 핸드 ${g.handNumber}` +
        ` · 은행에서 생성된 칩 ${st.bankChips + st.joinChips} (하이리스크 ${st.bankChips}, 중도 참여 지급 ${st.joinChips})` +
        ` · 은행으로 빠진 칩 ${st.bankTaxed + st.bankPaid} (세금 ${st.bankTaxed}, 나 다시 돌아갈래 ${st.bankPaid}) · 추방으로 사라진 칩 ${st.kickedChips}`,
    );
    console.table(rows);
  }

  private onNewDecision(kind: PendingKind, seq: number): void {
    if (this.decisionTimer) clearTimeout(this.decisionTimer);
    this.decisionTimer = null;
    this.deadline = null;
    this.deadlineKind = null;
    let base: number;
    switch (kind) {
      case 'turn': {
        // 플레이어별 행동 제한 시간 (메이드 인 헤븐 등으로 줄어들 수 있음, 최소 5초)
        const g = this.game!;
        const id = g.toAct !== null ? g.players[g.toAct]?.id : undefined;
        base = (id ? turnSecondsFor(g, id, this.settings.turnSeconds) : this.settings.turnSeconds) * 1000;
        break;
      }
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
      if (!g.players.some((p) => p.id === m.id)) continue;
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
      name: this.name,
      isPublic: this.isPublic,
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
    const connected: Record<string, boolean> = {};
    for (const pv of view.players) {
      const mm = this.member(pv.id);
      pv.connected = !!mm && (mm.isBot || mm.connected);
      pv.isHost = pv.id === this.hostId;
      connected[pv.id] = pv.connected;
    }
    for (const j of view.joiners) connected[j.id] = !!this.member(j.id)?.connected;
    // 중도 참여자의 증강 선택은 각자 따로 30초
    const joinDeadline = this.joinerDeadlines.get(forId);
    return {
      code: this.code,
      name: this.name,
      isPublic: this.isPublic,
      settings: { ...this.settings },
      connected,
      view,
      deadline: joinDeadline ?? this.deadline,
      deadlineKind: joinDeadline ? 'pick' : this.deadlineKind,
      serverNow: Date.now(),
      youAreHost: forId === this.hostId,
      debug: this.opts.debug,
    };
  }

  /** 각 사람에게 그 사람의 뷰만 개별 전송 (모두에게 같은 데이터를 뿌리지 않는다) */
  broadcast(): void {
    for (const m of this.members) {
      if (m.isBot || m.kicked || !m.socketId) continue;
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
  private listTimer: NodeJS.Timeout | null = null;
  private lastList = '';

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

  createRoom(hostName: string, roomName?: unknown, isPublic = true): { room: Room; member: Member } | string {
    if (this.rooms.size >= this.opts.maxRooms) return `지금은 방이 너무 많습니다 (최대 ${this.opts.maxRooms}개). 잠시 후 다시 시도하거나 공개 방에 입장해 보세요.`;
    const room = new Room(
      this.newCode(),
      this.io,
      this.opts,
      (r) => {
        this.rooms.delete(r.code);
        for (const [t, v] of this.tokens) if (v.code === r.code) this.tokens.delete(t);
        this.listChanged();
      },
      () => this.listChanged(),
      (token) => this.tokens.delete(token),
    );
    room.name = sanitizeRoomName(roomName) ?? `${hostName}님의 방`.slice(0, ROOM_NAME_MAX);
    room.isPublic = isPublic;
    this.rooms.set(room.code, room);
    const member = room.addHuman(hostName);
    this.tokens.set(member.token, { code: room.code, memberId: member.id });
    this.listChanged();
    return { room, member };
  }

  /** prevToken: 이 브라우저가 전에 이 방에서 쓰던 토큰 (탈락·추방된 사람의 재참여를 막는다) */
  join(code: string, name: string, prevToken?: unknown): { room: Room; member: Member } | string {
    const room = this.rooms.get(code);
    if (!room) return '방을 찾을 수 없습니다.';
    if (typeof prevToken === 'string' && prevToken) {
      if (room.revokedTokens.has(prevToken)) return '추방된 방에는 다시 들어갈 수 없습니다.';
      const prev = this.byToken(prevToken);
      if (prev && prev.room === room && room.game) {
        const p = room.game.players.find((x) => x.id === prev.member.id) ?? room.game.retired.find((x) => x.id === prev.member.id);
        if (p?.out) return '탈락한 플레이어는 같은 게임에 다시 참여할 수 없습니다.';
      }
    }
    const member = room.addMember(name);
    if (typeof member === 'string') return member;
    this.tokens.set(member.token, { code: room.code, memberId: member.id });
    this.listChanged();
    return { room, member };
  }

  byToken(token: unknown): { room: Room; member: Member } | null {
    if (typeof token !== 'string') return null;
    const t = this.tokens.get(token);
    if (!t) return null;
    const room = this.rooms.get(t.code);
    const member = room?.member(t.memberId);
    if (!room || !member || member.kicked) {
      this.tokens.delete(token);
      return null;
    }
    return { room, member };
  }

  /** 토큰이 추방으로 무효화되었는가 */
  isRevoked(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    for (const r of this.rooms.values()) if (r.revokedTokens.has(token)) return true;
    return false;
  }

  forgetToken(token: string): void {
    this.tokens.delete(token);
  }

  /** 공개 방 목록: 대기 중인 방이 위로, 그다음 입장 가능한 방 */
  publicList(): RoomListItem[] {
    const order = (x: RoomListItem) => (x.status === 'waiting' ? 0 : 1) * 2 + (x.joinable ? 0 : 1);
    return [...this.rooms.values()]
      .filter((r) => r.isPublic && !r.deleted)
      .map((r) => r.listItem())
      .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, 'ko'));
  }

  /** 목록 구독자에게 실시간 갱신 (짧게 모아서, 바뀐 경우에만) */
  listChanged(): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      const list = this.publicList();
      const json = JSON.stringify(list);
      if (json === this.lastList) return;
      this.lastList = json;
      this.io.to(LIST_ROOM).emit('rooms', list);
    }, 100);
  }

  shutdown(): void {
    if (this.listTimer) clearTimeout(this.listTimer);
    for (const r of [...this.rooms.values()]) r.destroy();
  }
}

/** 공개 방 목록을 보고 있는 소켓들의 socket.io 방 이름 */
export const LIST_ROOM = 'room-list';
