// 클라이언트: 서버가 보내 준 "내 화면 정보"(PlayerView)만으로 화면을 그린다.
// 게임 규칙 판단은 하지 않으며, 모든 행동은 서버로 보내 검증받는다.

import { io, type Socket } from 'socket.io-client';
import './style.css';
import type { ChatMessage, DebugView, GameEnvelope, LobbyState, RoomListItem, RoomSettings } from '../../server/src/protocol.js';
import { blindsAt } from '../../engine/src/core.js';
import type { MyAugmentView, PlayerView, PublicPlayerView } from '../../engine/src/view.js';
import { AUGMENTS, type AugmentId } from '../../engine/src/augments.js';
import { $, augTip, cardBack, cardHtml, esc, fmt, mount, patch, richText, stars } from './dom.js';
import { isMuted, play, setMuted, sfxForLog, type Sfx } from './sfx.js';
import { handCardClass, handPanelHtml, handTableHtml } from './hand.js';

type Screen = 'home' | 'lobby' | 'game';
interface Seat {
  code: string;
  token: string;
  playerId: string;
}
type Res = { ok: boolean; error?: string; code?: string; token?: string; playerId?: string };

const app = {
  screen: 'home' as Screen,
  lobby: null as LobbyState | null,
  env: null as GameEnvelope | null,
  debug: null as DebugView | null,
  revealAll: false,
  offset: 0,
  connected: false,
  everConnected: false,
  seat: null as Seat | null,
  raise: 0,
  raiseKey: '',
  targets: {} as Record<string, string>,
  fake: '' as string,
  fakeCard: '' as string,
  homeError: '',
  homeName: '',
  homeCode: '',
  homeRoomName: '',
  homePublic: true,
  rooms: [] as RoomListItem[],
  watchingRooms: false,
  /** 서버(디버그)가 연결을 끊어 자동 재연결하지 않는 상태 */
  forcedOff: false,
  showSettings: false,
  /** 데스티니 드로우 카드 선택 창 */
  destinyOpen: false,
  /** 내기할래? 선택 창을 건너뛴 핸드 */
  betSkipHand: -1,
  betOpen: false,
  radarIdx: 0,
  rumor: 'observer' as string,
  /** 좌석 위에 잠깐 크게 띄우는 행동 표시: playerId → 문구·종류·끝 시각 */
  flashes: new Map<string, { text: string; kind: string; until: number }>(),
  /** 증강으로 새로 알게 된 정보를 크게 보여 주는 창 */
  reveal: null as { title: string; body: string; cards: string[]; until: number } | null,
  /** 효과음을 낸 마지막 로그 번호 */
  sfxSeq: 0,
  lastTickSec: -1,
  lastLogSeq: 0,
  showHandTable: false,
  chat: [] as ChatMessage[],
  unread: 0,
  sideTab: 'log' as 'log' | 'chat',
  /** 좌석 위 말풍선: playerId → 표시 끝 시각 */
  bubbles: new Map<string, { text: string; until: number }>(),
};

const BUBBLE_MS = 6000;

// ───────── 저장소 (탭별 sessionStorage 로 자동 복귀, localStorage 는 '이전 방으로' 버튼용) ─────────

const SESSION_KEY = 'ah.seat';
const LAST_KEY = 'ah.lastSeat';
const NAME_KEY = 'ah.name';

function storageGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(store: Storage, key: string, value: string | null) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* 사생활 보호 모드 등 */
  }
}
function readSeat(store: Storage, key: string): Seat | null {
  try {
    const v = JSON.parse(storageGet(store, key) ?? 'null');
    return v && typeof v.token === 'string' && typeof v.code === 'string' ? v : null;
  } catch {
    return null;
  }
}
function saveSeat(seat: Seat) {
  app.seat = seat;
  storageSet(sessionStorage, SESSION_KEY, JSON.stringify(seat));
  storageSet(localStorage, LAST_KEY, JSON.stringify(seat));
}
function forgetSeat() {
  const last = readSeat(localStorage, LAST_KEY);
  if (last && app.seat && last.token === app.seat.token) storageSet(localStorage, LAST_KEY, null);
  storageSet(sessionStorage, SESSION_KEY, null);
  app.seat = null;
}

// ───────── 소켓 ─────────

const socket: Socket = io({ autoConnect: true });

function send(event: string, payload: unknown = {}): Promise<Res> {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err: unknown, res: Res) => {
      resolve(err ? { ok: false, error: '서버 응답이 없습니다.' } : res);
    });
  });
}

async function act(action: Record<string, unknown>) {
  const r = await send('game:action', action);
  if (!r.ok) toast(r.error ?? '실패했습니다.');
}

async function resume(seat: Seat, auto: boolean) {
  const r = await send('room:resume', { token: seat.token });
  if (r.ok) {
    saveSeat({ code: r.code!, token: r.token!, playerId: r.playerId! });
  } else {
    if (auto) storageSet(sessionStorage, SESSION_KEY, null);
    if (!auto) storageSet(localStorage, LAST_KEY, null);
    app.seat = null;
    app.screen = 'home';
    app.homeError = r.error ?? '복귀하지 못했습니다.';
    render();
  }
}

socket.on('connect', () => {
  app.connected = true;
  app.everConnected = true;
  renderConn();
  if (app.seat) resume(app.seat, true);
  else if (app.screen === 'home') render();
});
socket.on('disconnect', (reason: string) => {
  app.connected = false;
  app.watchingRooms = false;
  app.forcedOff = reason === 'io server disconnect';
  renderConn();
});
socket.on('rooms', (list: RoomListItem[]) => {
  app.rooms = list;
  if (app.screen === 'home') renderRoomList();
});
socket.on('lobby', (s: LobbyState) => {
  app.lobby = s;
  app.env = null;
  app.debug = null;
  app.screen = 'lobby';
  render();
});
socket.on('game', (e: GameEnvelope) => {
  onGameUpdate(app.env?.view ?? null, e.view);
  app.env = e;
  app.offset = e.serverNow - Date.now();
  app.screen = 'game';
  render();
});
socket.on('debug:state', (d: DebugView | null) => {
  app.debug = d;
  if (app.screen === 'game') renderDebug();
});
socket.on('chat:history', (list: ChatMessage[]) => {
  app.chat = list.slice(-100);
  app.unread = 0;
  renderChat();
});
socket.on('chat', (m: ChatMessage) => {
  app.chat.push(m);
  if (app.chat.length > 100) app.chat.splice(0, app.chat.length - 100);
  if (m.fromId !== myId() && app.screen === 'game' && app.sideTab !== 'chat') app.unread++;
  app.bubbles.set(m.fromId, { text: m.text, until: Date.now() + BUBBLE_MS });
  renderChat();
  if (app.screen === 'game' && app.env) renderTable(app.env.view);
});
socket.on('kicked', (reason: string) => {
  storageSet(sessionStorage, SESSION_KEY, null);
  const last = readSeat(localStorage, LAST_KEY);
  if (last && app.seat && last.token === app.seat.token && reason.includes('추방')) storageSet(localStorage, LAST_KEY, null);
  app.seat = null;
  app.env = null;
  app.lobby = null;
  app.screen = 'home';
  app.homeError = reason;
  render();
});

// ───────── 행동 표시·효과음 ─────────

const FLASH_MS = 2600;

/** 행동 문구 → 표시 종류 (색) */
function actionKind(text: string): string {
  if (/폴드|추방/.test(text)) return 'fold';
  if (/올인/.test(text)) return 'allin';
  if (/레이즈|베팅/.test(text)) return 'raise';
  if (/콜/.test(text)) return 'call';
  if (/체크/.test(text)) return 'check';
  if (/SB|BB|앤티|면제/.test(text)) return 'blind';
  return 'other';
}

/** 새 뷰가 도착할 때: 바뀐 행동은 좌석 위에 크게 띄우고, 새 로그에 맞춰 효과음 */
function onGameUpdate(prev: PlayerView | null, next: PlayerView) {
  const now = Date.now();
  if (prev && prev.handNumber === next.handNumber) {
    for (const p of next.players) {
      const before = prev.players.find((x) => x.id === p.id);
      if (p.lastAction && before && before.lastAction !== p.lastAction) {
        app.flashes.set(p.id, { text: p.lastAction, kind: actionKind(p.lastAction), until: now + FLASH_MS });
      }
    }
  }
  // 효과음: 처음 받은 뷰(입장·재접속)에서는 내지 않는다
  const fresh = next.log.filter((e) => e.seq > app.sfxSeq);
  if (app.sfxSeq > 0) {
    const kinds = [...new Set(fresh.map((e) => sfxForLog(e.text)).filter((k): k is Sfx => !!k))].slice(0, 3);
    kinds.forEach((k, i) => setTimeout(() => play(k), i * 110));
  }
  app.sfxSeq = Math.max(app.sfxSeq, next.log.at(-1)?.seq ?? 0);
  // 증강으로 새로 알게 된 비공개 정보: 화면 가운데 위에 크게 (같은 핸드 안에서 새로 생긴 것만)
  if (prev && prev.handNumber === next.handNumber && next.you.notes.length > prev.you.notes.length) {
    const fresh = next.you.notes.slice(prev.you.notes.length).filter((n) => n.hand === next.handNumber);
    const n = fresh.at(-1);
    if (n) {
      const i = n.text.indexOf(':');
      app.reveal = {
        title: i > 0 ? n.text.slice(0, i) : '나만 아는 정보',
        body: i > 0 ? n.text.slice(i + 1).trim() : n.text,
        cards: n.cards ?? [],
        until: now + 6000,
      };
      setTimeout(() => app.env && renderGame(), 6100);
    }
  }
  // 내 차례가 새로 오면 알림음
  if (next.toActId === next.you.id && prev?.toActId !== next.you.id) setTimeout(() => play('turn'), 150);
}

// ───────── 공통 ─────────

let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $('#toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 3200);
}

function renderConn() {
  const el = $('#conn')!;
  const show = app.everConnected && !app.connected;
  el.className = show ? 'show' : '';
  if (!show) el.innerHTML = '';
  else if (app.forcedOff) el.innerHTML = '서버가 연결을 끊었습니다. <button class="small" data-a="reconnect">다시 연결</button>';
  else el.textContent = '서버와 연결이 끊겼습니다. 재연결 중…';
}

function roomLink(code: string) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

async function copyLink(code: string) {
  const link = roomLink(code);
  try {
    await navigator.clipboard.writeText(link);
    toast('방 링크를 복사했습니다.');
  } catch {
    window.prompt('아래 링크를 복사해 공유하세요', link);
  }
}

function render() {
  document.body.dataset.screen = app.screen;
  // 공개 방 목록은 첫 화면에 있을 때만 실시간으로 받는다
  const wantRooms = app.screen === 'home' && app.connected;
  if (wantRooms !== app.watchingRooms && (app.connected || !wantRooms)) {
    app.watchingRooms = wantRooms;
    void send('rooms:watch', { on: wantRooms });
  }
  if (app.screen === 'home') renderHome();
  else if (app.screen === 'lobby') renderLobby();
  else renderGame();
}

// ───────── 첫 화면 ─────────

function syncHomeInputs() {
  const n = $('#home-name') as HTMLInputElement | null;
  const c = $('#home-code') as HTMLInputElement | null;
  const r = $('#home-room') as HTMLInputElement | null;
  if (n) app.homeName = n.value;
  if (c) app.homeCode = c.value;
  if (r) app.homeRoomName = r.value;
}

function renderHome() {
  $('#modal')!.innerHTML = '';
  if (!$('.home')) {
    // 입력칸은 목록이 실시간으로 바뀌어도 유지되도록 뼈대에 한 번만 그린다
    mount(
      $('#app'),
      `<div class="home">
        <h1><span class="logo">♠</span> 증강 홀덤</h1>
        <p class="sub">텍사스 홀덤 + 증강 · 최대 8명</p>
        <label class="field">닉네임<input id="home-name" maxlength="12" autocomplete="nickname" value="${esc(app.homeName)}" placeholder="12자 이내" /></label>
        <div class="panel create-box">
          <h3>방 만들기</h3>
          <label class="field">방 이름<input id="home-room" maxlength="20" value="${esc(app.homeRoomName)}" placeholder="비워 두면 ○○님의 방" /></label>
          <div class="vis-row">
            <label class="check"><input type="radio" name="vis" value="public" ${app.homePublic ? 'checked' : ''}/> 공개 <span class="muted">(목록에 표시)</span></label>
            <label class="check"><input type="radio" name="vis" value="private" ${app.homePublic ? '' : 'checked'}/> 비공개 <span class="muted">(코드·링크로만)</span></label>
          </div>
          <button class="primary big" data-a="create">방 만들기</button>
        </div>
        <div class="or">또는</div>
        <div class="join-row">
          <input id="home-code" maxlength="5" placeholder="방 코드 5자리" value="${esc(app.homeCode)}" autocapitalize="characters" />
          <button class="big" data-a="join">방 코드로 입장</button>
        </div>
        <div id="home-extra"></div>
        <div class="panel rooms"><h3>공개 방 목록 <span class="rooms-tools"><span class="muted small-note">실시간</span><button class="small" data-a="roomsRefresh" title="목록 새로고침">↻ 새로고침</button></span></h3><div id="home-rooms"></div></div>
      </div>`,
    );
  }
  const last = readSeat(localStorage, LAST_KEY);
  patch(
    $('#home-extra'),
    `${last ? `<button class="ghost" data-a="resumeLast">이전 방(${esc(last.code)})의 내 자리로 돌아가기</button>` : ''}
     <p class="err">${esc(app.homeError)}</p>`,
  );
  renderRoomList();
}

function renderRoomList() {
  const el = $('#home-rooms');
  if (!el) return;
  if (!app.rooms.length) {
    patch(el, '<div class="muted empty">지금 열려 있는 공개 방이 없습니다</div>');
    return;
  }
  patch(
    el,
    `<ul class="room-list">${app.rooms
      .map((r) => {
        const status = r.status === 'waiting' ? '<span class="st wait">대기 중</span>' : '<span class="st play">게임 중</span>';
        const mid = r.status === 'playing' ? (r.midJoin ? '<span class="tag">중도 참여 가능</span>' : '<span class="tag off">중도 참여 불가</span>') : '';
        return `<li class="${r.joinable ? '' : 'full'}">
          <div class="rl-main"><b class="rl-name">${esc(r.name)}</b> ${status} ${mid}
            <div class="muted rl-meta">${r.players}/${r.maxPlayers}명 · 시작 칩 ${fmt(r.startingChips)} · 블라인드 ${fmt(r.smallBlind)}/${fmt(r.bigBlind)}</div></div>
          <button class="small primary" data-a="joinList" data-code="${esc(r.code)}" ${r.joinable ? '' : 'disabled'} title="${r.joinable ? '' : r.players >= r.maxPlayers ? '방이 가득 찼습니다' : '중도 참여가 꺼져 있습니다'}">입장</button></li>`;
      })
      .join('')}</ul>`,
  );
}

async function homeEnter(kind: 'create' | 'join', listCode?: string) {
  syncHomeInputs();
  const name = app.homeName.trim();
  if (!name) {
    app.homeError = '닉네임을 입력하세요.';
    return renderHome();
  }
  storageSet(localStorage, NAME_KEY, name);
  const code = (listCode ?? app.homeCode).trim().toUpperCase();
  // 이 브라우저가 전에 이 방에서 쓰던 토큰 (탈락·추방된 사람은 다시 참여할 수 없다)
  const prev = readSeat(localStorage, LAST_KEY);
  const r =
    kind === 'create'
      ? await send('room:create', { name, roomName: app.homeRoomName.trim(), isPublic: app.homePublic })
      : await send('room:join', { name, code, prevToken: prev?.code === code ? prev.token : undefined });
  if (!r.ok) {
    app.homeError = r.error ?? '실패했습니다.';
    return renderHome();
  }
  app.homeError = '';
  saveSeat({ code: r.code!, token: r.token!, playerId: r.playerId! });
  history.replaceState(null, '', `?room=${r.code}`);
}

// ───────── 대기실 ─────────

function myId(): string {
  return app.env?.view.you.id ?? app.lobby?.youId ?? '';
}

const CHAT_FORM = `<form class="chat-form" data-chat><input name="msg" maxlength="200" placeholder="메시지 입력 후 Enter" autocomplete="off" enterkeyhint="send" /><button>전송</button></form>`;

function chatListHtml(): string {
  if (!app.chat.length) return '<div class="muted chat-empty">아직 메시지가 없습니다</div>';
  const me = myId();
  return app.chat
    .map((m) => {
      const t = new Date(m.ts);
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return `<div class="cm ${m.fromId === me ? 'mine' : ''}${m.fromId === '' ? ' sys' : ''}"><span class="cm-name">${esc(m.name)}</span><span class="cm-text">${esc(m.text)}</span><span class="cm-time">${hhmm}</span></div>`;
    })
    .join('');
}

/** 대기실·게임 화면의 채팅 목록과 안 읽은 수 갱신 */
function renderChat() {
  for (const sel of ['#lobby-chat-list', '#g-chat']) {
    const el = $(sel);
    if (!el) continue;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (patch(el, chatListHtml()) && nearBottom) el.scrollTop = el.scrollHeight;
  }
  const side = $('.side');
  if (side) side.dataset.tab = app.sideTab;
  const badge = $('#chat-unread');
  if (badge) badge.textContent = app.unread ? String(app.unread) : '';
}

/** 이 영역의 글자·숫자 입력칸에 입력하는 중인가 (체크박스·선택 상자는 제외) */
function typingIn(root: Element | null | undefined): boolean {
  const el = document.activeElement as HTMLInputElement | null;
  return !!root && !!el && el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number') && root.contains(el);
}

const TURN_CHOICES = [15, 20, 25, 30, 40, 45, 50, 60];
const KICK_LABEL: Record<number, string> = { 0: '끄기', 3: '3분', 5: '5분', 10: '10분' };

/** 블라인드 진행 미리 보기 (예: 10/20 → 20/40 → 40/80 …) */
function blindPreview(s: RoomSettings, levels = 6): string {
  return Array.from({ length: levels }, (_, i) => {
    const b = blindsAt(i, s.bigBlind, s.blindSchedule);
    return `${fmt(b.sb)}/${fmt(b.bb)}`;
  }).join(' → ') + ' …';
}

function settingsSummary(s: RoomSettings, bots: number | null): string {
  const bbx = s.startingChips / s.bigBlind;
  return `<ul class="summary">
    <li>최대 ${s.maxPlayers}명${bots === null ? '' : ` · 봇 ${s.fillBots ? `${bots}명` : '없음'}`} · 제한 시간 ${s.turnSeconds}초</li>
    <li>시작 칩 ${fmt(s.startingChips)} (${Math.floor(bbx)}BB) · 시작 블라인드 ${fmt(blindsAt(0, s.bigBlind).sb)}/${fmt(s.bigBlind)}</li>
    <li>상승: ${s.levelMode === 'auto' ? '자동 (남은 인원 × 2핸드)' : `${s.levelHands}핸드마다`} · ${s.blindSchedule === 'x1.5' ? '1.5배씩' : '기본 표'}</li>
    <li class="muted">${blindPreview(s)}</li>
    <li>중도 참여 ${s.midJoin ? '허용' : '끔'} · 연결 끊긴 플레이어 자동 추방 ${KICK_LABEL[s.autoKickMinutes] ?? `${s.autoKickMinutes}분`}</li>
    <li>재충전 선택 ${s.recharge ? '켜짐' : '꺼짐'}</li>
  </ul>`;
}

/** 방장용 설정 폼. inGame 이면 칩·블라인드·봇은 잠근다 */
function settingsForm(s: RoomSettings, room: { name: string; isPublic: boolean }, humans: number, inGame: boolean): string {
  const opt = (vals: (number | string)[], cur: number | string, label: (v: number | string) => string = String) =>
    vals.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label(v))}</option>`).join('');
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const bbx = s.startingChips / s.bigBlind;
  const sb = blindsAt(0, s.bigBlind).sb;
  return `<label>방 이름 <input data-setting="name" data-kind="str" maxlength="20" value="${esc(room.name)}" /></label>
    <label class="check"><input type="checkbox" data-setting="isPublic" ${room.isPublic ? 'checked' : ''}/> 공개 방 (공개 방 목록에 표시)</label>
    <label>최대 인원 <select data-setting="maxPlayers">${opt(range(inGame ? 2 : Math.max(2, humans), 8), s.maxPlayers)}</select></label>
    ${
      inGame
        ? ''
        : `<label class="check"><input type="checkbox" data-setting="fillBots" ${s.fillBots ? 'checked' : ''}/> 빈자리를 봇으로 채우기</label>
    <label>봇 수 <select data-setting="botCount" ${s.fillBots ? '' : 'disabled'}>${opt(range(0, Math.max(0, s.maxPlayers - humans)), Math.min(s.botCount, s.maxPlayers - humans))}</select></label>`
    }
    <label>행동 제한 시간 <select data-setting="turnSeconds">${opt(TURN_CHOICES, s.turnSeconds, (v) => `${v}초`)}</select></label>
    ${inGame ? `<div class="locked-row">시작 칩 ${fmt(s.startingChips)} (${Math.floor(bbx)}BB) · 시작 블라인드 ${fmt(sb)}/${fmt(s.bigBlind)} · ${s.blindSchedule === 'x1.5' ? '1.5배씩' : '기본 표'} <span class="muted">(잠김)</span></div>` : `
    <label>시작 칩 <span class="inline-num"><input type="number" data-setting="startingChips" min="200" max="10000" step="100" value="${s.startingChips}" />
      <b class="${bbx < 10 ? 'warn' : 'muted'}">${Math.floor(bbx)}BB</b></span></label>
    ${bbx < 10 ? '<div class="warn">시작 칩이 10BB 미만이면 시작할 수 없습니다.</div>' : ''}
    <label>시작 블라인드 <span class="inline-num"><span class="muted">SB ${fmt(sb)} / BB</span><input type="number" data-setting="bigBlind" min="2" max="1000" value="${s.bigBlind}" /></span></label>
    `}
    <label>블라인드 상승 주기 <span class="inline-num"><select data-setting="levelMode" data-kind="str">${opt(['auto', 'fixed'], s.levelMode, (v) => (v === 'auto' ? '자동 (인원 × 2핸드)' : '고정'))}</select>
      ${s.levelMode === 'fixed' ? `<select data-setting="levelHands">${opt(range(4, 30), s.levelHands, (v) => `${v}핸드마다`)}</select>` : ''}</span></label>
    ${inGame ? '<div class="muted small-note">상승 주기를 바꾸면 다음 레벨부터 적용됩니다.</div>' : ''}
    ${inGame ? '' : `<label>블라인드 상승 방식 <select data-setting="blindSchedule" data-kind="str">${opt(['standard', 'x1.5'], s.blindSchedule, (v) => (v === 'standard' ? '기본 표' : '1.5배씩'))}</select></label>`}
    <div class="muted small-note">${blindPreview(s)}</div>
    <label class="check"><input type="checkbox" data-setting="midJoin" ${s.midJoin ? 'checked' : ''}/> 중도 참여 허용</label>
    ${
      inGame
        ? `<div class="locked-row">재충전 선택 ${s.recharge ? '켜짐' : '꺼짐'} <span class="muted">(잠김)</span></div>`
        : `<label class="check" title="증강 선택 화면에 재충전 카드: 새 증강 대신 내 액티브 증강 1개의 횟수를 처음으로 되돌림"><input type="checkbox" data-setting="recharge" ${s.recharge ? 'checked' : ''}/> 재충전 선택 허용</label>`
    }
    <label>연결 끊긴 플레이어 자동 추방 <select data-setting="autoKickMinutes">${opt([0, 3, 5, 10], s.autoKickMinutes, (v) => KICK_LABEL[Number(v)])}</select></label>`;
}

function renderLobby() {
  $('#modal')!.innerHTML = '';
  if (!$('.lobby-wrap')) {
    // 채팅 입력칸은 대기실이 다시 그려져도 유지되도록 뼈대에 고정
    mount(
      $('#app'),
      `<div class="lobby-wrap"><div id="lobby-main"></div>
        <div class="panel chatbox"><h3>채팅</h3><div class="chat-list" id="lobby-chat-list"></div>${CHAT_FORM}</div></div>`,
    );
    // 채팅 기록은 대기실 화면보다 먼저 도착할 수 있다
    renderChat();
  }
  // 설정을 입력하는 중에는 다시 그리지 않는다 (입력이 끝나면 change 로 반영됨)
  if (typingIn($('#lobby-main')?.querySelector('.settings'))) return;
  const l = app.lobby!;
  const isHost = l.youId === l.hostId;
  const s = l.settings;
  const humans = l.players.length;
  const bots = s.fillBots ? Math.min(s.botCount, s.maxPlayers - humans) : 0;
  const tooFewChips = s.startingChips < s.bigBlind * 10;
  const settings = isHost
    ? settingsForm(s, l, humans, false)
    : `${settingsSummary(s, bots)}<p class="muted">방장이 설정하고 시작합니다.</p>`;
  patch(
    $('#lobby-main'),
    `<div class="lobby">
      <div class="lobby-head">
        <div><b class="room-name">${esc(l.name)}</b> <span class="tag">${l.isPublic ? '공개' : '비공개'}</span><br/>방 코드 <b class="code">${esc(l.code)}</b></div>
        <button data-a="copy">링크 복사</button>
      </div>
      <div class="panel">
        <h3>참가자 ${humans}/${s.maxPlayers}${bots ? ` <span class="muted">+ 봇 ${bots}</span>` : ''}</h3>
        <ul class="plist">
          ${l.players
            .map(
              (p) =>
                `<li class="${p.connected ? '' : 'off'}">${p.isHost ? '<span class="crown">👑</span>' : ''}${esc(p.name)}${p.id === l.youId ? ' <span class="muted">(나)</span>' : ''}${p.connected ? '' : ' <span class="muted">연결 끊김</span>'}${
                  isHost && p.id !== l.youId && p.connected ? ` <button class="small" data-a="giveHost" data-id="${esc(p.id)}" data-name="${esc(p.name)}">방장 넘기기</button>` : ''
                }</li>`,
            )
            .join('')}
          ${Array.from({ length: bots }, (_, i) => `<li class="bot">🤖 봇 ${i + 1}</li>`).join('')}
        </ul>
      </div>
      <div class="panel settings">
        <h3>설정</h3>
        ${settings}
      </div>
      <div class="lobby-actions">
        ${isHost ? `<button class="primary big" data-a="start" ${humans + bots >= 2 && !tooFewChips ? '' : 'disabled'}>게임 시작</button>` : ''}
        <button data-a="leave">나가기</button>
      </div>
      ${humans + bots < 2 && isHost ? '<p class="muted tcenter">친구에게 링크를 보내거나 봇으로 빈자리를 채우세요.</p>' : ''}
      ${l.debug ? '<p class="debug-flag">DEBUG 모드</p>' : ''}
    </div>`,
  );
}

// ───────── 게임 화면 ─────────

const GAME_SKELETON = `<div class="game">
  <header class="topbar" id="g-top"></header>
  <div class="table-wrap"><div class="table" id="g-table"><div class="felt"></div><div id="g-seats"></div><div class="center" id="g-center"></div><div id="g-result"></div></div></div>
  <section class="me" id="g-me"><div class="me-left"><div id="g-hand"></div><div id="g-actions"></div></div><div class="augs" id="g-augs"></div></section>
  <aside class="side" data-tab="log"><div id="g-notes"></div>
    <div class="side-tabs"><button data-a="sideTab" data-tab="log">게임 로그</button><button data-a="sideTab" data-tab="chat">채팅 <span class="badge" id="chat-unread"></span></button></div>
    <div class="log" id="g-log"></div><div class="chat-list" id="g-chat"></div>${CHAT_FORM}
    <div id="g-debug"></div></aside>
  <div id="g-handtable"></div>
</div>`;

function nameOf(v: PlayerView, id: string | null) {
  return v.players.find((p) => p.id === id)?.name ?? '';
}

function remainingMs(): number | null {
  const d = app.env?.deadline;
  if (!d) return null;
  return Math.max(0, d - (Date.now() + app.offset));
}

function renderGame() {
  const env = app.env!;
  const v = env.view;
  document.body.classList.toggle('my-turn', !!v.you.legal);
  document.body.classList.toggle('blurred', v.masks.suits || v.masks.board);
  if (!$('.game')) {
    mount($('#app'), GAME_SKELETON);
    renderChat();
  }
  renderTop(env, v);
  renderTable(v);
  renderHand(v);
  renderActions(v);
  renderAugments(v);
  renderNotes(v);
  renderLog(v);
  renderModal(env, v);
  renderDebug();
  tick();
}

function waitingText(v: PlayerView): string {
  switch (v.waiting.kind) {
    case 'turn':
      return v.waiting.playerId === v.you.id ? '내 차례' : `${esc(nameOf(v, v.waiting.playerId))}의 차례`;
    case 'pick':
      return `증강 선택 중 (${v.waiting.count}명 남음)`;
    case 'discard':
      return '플랍 직후 결정 대기 중';
    case 'declare':
      return v.you.declare ? '선언 기회: 내 차례' : '선언 기회 대기 중';
    case 'reaction':
      return '증강 반응 대기 중';
    case 'respond':
      return v.respond ? `${esc(v.respond.name)}: ${esc(v.respond.text)}` : '응답 대기 중';
    case 'handEnd':
      return '다음 핸드 준비 중';
    case 'gameOver':
      return '게임 종료';
    default:
      return '';
  }
}

function renderTop(env: GameEnvelope, v: PlayerView) {
  patch(
    $('#g-top'),
    `<div class="tb-left"><b class="code" data-a="copy" title="링크 복사">${esc(env.code)}</b>
      <span>핸드 #${v.handNumber}</span>
      <span>레벨 ${v.level} · 블라인드 ${fmt(v.blinds.sb)}/${fmt(v.blinds.bb)}</span>
      <span class="muted">다음 레벨까지 ${Math.max(0, v.handsUntilLevelUp)}핸드</span>
      <span class="muted">남은 인원 ${v.alive}명</span>
      ${v.joiners.length ? `<span class="muted hide-sm" title="다음 핸드부터 참여">참여 대기: ${esc(v.joiners.map((j) => j.name).join(', '))}</span>` : ''}
      ${v.table.underdogHands ? `<span class="taxbadge" title="언더독: 족보 순위가 뒤바뀌는 남은 핸드 수 (이번 핸드 포함)">🐶 언더독 ${v.table.underdogHands}핸드</span>` : ''}
      ${v.table.taxers.length ? `<span class="taxbadge" title="죽음과 세금 선언자: ${esc(v.table.taxers.join(', '))}">💀 세금 ${v.you.tax ? `${fmt(v.you.tax)}칩/사용` : '면제'}</span>` : ''}</div>
     <div class="tb-right"><span class="wait">${waitingText(v)} <span class="timer-text" data-timer></span></span>
      ${env.debug ? '<span class="debug-flag">DEBUG</span>' : ''}
      <button class="small" data-a="mute" title="효과음 켜기/끄기">${isMuted() ? '🔇' : '🔊'}</button>
      <button class="small" data-a="settings">${env.youAreHost ? '방 설정' : '설정 보기'}</button>
      <button class="small" data-a="leave">나가기</button></div>`,
  );
}

function seatPos(k: number, n: number) {
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  const theta = Math.PI / 2 + (2 * Math.PI * k) / n;
  const rx = mobile ? 38 : 43;
  const ry = mobile ? 41 : 39;
  return { x: 50 + rx * Math.cos(theta), y: 50 + ry * Math.sin(theta) };
}

function seatHtml(v: PlayerView, p: PublicPlayerView, k: number, n: number): string {
  const { x, y } = seatPos(k, n);
  const me = p.id === v.you.id;
  const cls = ['seat', me ? 'mine' : '', p.team !== null ? `team team-${p.team % 4}` : '', p.isTurn ? 'turn' : '', p.folded ? 'folded' : '', p.out || p.kicked ? 'out' : '', p.connected ? '' : 'off']
    .filter(Boolean)
    .join(' ');
  const badges = [p.isDealer ? '<i class="b d">D</i>' : '', p.isSB ? '<i class="b">SB</i>' : '', p.isBB ? '<i class="b">BB</i>' : '']
    .join('');
  let cards = '';
  if (p.shownCards) cards = p.shownCards.map((c) => cardHtml(c, { size: 'sm', extra: me ? handCardClass(v, c) : '' })).join('');
  else if (me && v.you.hole.length && !p.folded) cards = v.you.hole.map((c) => cardHtml(c, { size: 'sm', extra: handCardClass(v, c) })).join('');
  else if (p.hasCards) cards = cardBack('sm') + cardBack('sm');
  const status = p.kicked
    ? '추방됨'
    : p.dormant !== null
    ? `부활 대기 (${p.dormant}핸드 뒤)`
    : p.out
    ? `탈락${p.place ? ` (${p.place}위)` : ''}`
    : p.sittingOut
      ? '자리 비움'
      : !p.connected
        ? '연결 끊김'
        : p.allIn
          ? '올인'
          : (p.lastAction ?? '');
  const revealed = p.revealedAugments
    .map((a) => `<span class="pub s${a.stars}" data-tip="${esc(augTip(a.name) ?? a.description)}">${esc(a.name)}${stars(a.stars)}</span>`)
    .join('');
  const flash = app.flashes.get(p.id);
  const flashHtml = flash && flash.until > Date.now() ? `<div class="act-flash ${flash.kind}">${esc(flash.text)}</div>` : '';
  const shep = p.shepherdShown.length
    ? `<div class="seat-shep" title="양치기 소년으로 공개한 카드 (진짜인지 알 수 없음)">공개 ${p.shepherdShown.map((c) => cardHtml(c, { size: 'sm', extra: 'inline' })).join('')}</div>`
    : '';
  const bubble = app.bubbles.get(p.id);
  // 화면 위쪽 좌석은 말풍선을 아래로 (상단 바를 가리지 않도록)
  const bubbleHtml = bubble && bubble.until > Date.now() ? `<div class="bubble${y < 30 ? ' below' : ''}">${esc(bubble.text)}</div>` : '';
  const bx = 50 + (x - 50) * 0.62;
  const by = 50 + (y - 50) * 0.55;
  return `<div class="${cls}" style="left:${x}%;top:${y}%">${bubbleHtml}${flashHtml}
      <div class="seat-top"><span class="avatar">${p.isBot ? '🤖' : esc([...p.name][0] ?? '?')}</span><span class="nm">${esc(p.name)}</span>${p.isHost ? '<span class="crown" title="방장">👑</span>' : ''}${badges}</div>
      ${p.isTurn ? '<div class="seat-timer"><div class="fill" data-seat-timer></div></div>' : ''}
      <div class="seat-mid"><span class="chips">${p.approx ? '약 ' : ''}${fmt(p.chips)}</span><span class="cards">${cards}</span></div>
      <div class="seat-status">${esc(status)}${!p.connected && !p.out && !p.kicked ? ' ⚠' : ''}</div>
      ${canKick(p) ? `<button class="small kick" data-a="kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}">추방</button>` : ''}
      ${shep}
      ${(() => {
        const r = v.you.extra.recorder?.[p.id];
        return r && r.hands ? `<div class="seat-rec" title="기록관: 프리플랍 참여율 · 쇼다운에서 드러난 블러프 (${r.hands}핸드)">📒 VPIP ${r.vpip}% · 블러프 ${r.bluffs}</div>` : '';
      })()}
      <div class="seat-augs"><span class="cnt" title="보유 증강 수">증강 ${p.augmentCount}</span>${p.streak ? `<span class="streak" title="폭주기관차 연승">🔥${p.streak}연승</span>` : ''}${revealed}</div>
    </div>
    ${p.streetBet > 0 ? `<div class="bet" style="left:${bx}%;top:${by}%">${fmt(p.streetBet)}</div>` : ''}`;
}

/** 방장 화면: 연결 끊김·자리 비움 상태인 사람 좌석에 추방 버튼 (최종 검증은 서버) */
function canKick(p: PublicPlayerView): boolean {
  const env = app.env;
  if (!env?.youAreHost || p.isBot || p.out || p.kicked || p.id === env.view.you.id) return false;
  return !p.connected || p.sittingOut;
}

/** 증강으로 새로 알게 된 정보 (예지·투시 등): 큰 카드와 함께 몇 초간 */
function revealHtml(): string {
  const r = app.reveal;
  if (!r || r.until < Date.now()) return '';
  return `<div class="reveal" data-a="closeReveal" title="눌러서 닫기">
      <div class="reveal-title">🔮 ${esc(r.title)} <span class="muted">· 나만 보임</span></div>
      ${r.cards.length ? `<div class="reveal-cards">${r.cards.map((c) => cardHtml(c, { size: 'lg' })).join('')}</div>` : ''}
      <div class="reveal-body">${richText(r.body)}</div>
    </div>`;
}

function reactionHtml(v: PlayerView): string {
  const r = v.reaction;
  if (!r) return '';
  const who = r.mine ? '내' : `${esc(r.declarerName)}님의`;
  const tip = r.anonymous && !r.mine ? null : augTip(r.label);
  const what = r.anonymous && !r.mine ? '비공개 증강' : `<span class="aug-ref"${tip ? ` data-tip="${esc(tip)}"` : ''}>「${esc(r.label)}」</span>`;
  return `<div class="reaction ${r.countered ? 'countered' : ''}">
      <div>${who} ${what} 선언 <span class="timer-text" data-timer></span></div>
      ${r.countered ? `<div class="rx-sub">🛡 ${esc(r.counteredBy ?? '')}의 카운터 스펠로 무효화됨</div>` : '<div class="rx-sub">반응 대기 중…</div>'}
      ${r.canCounter && !r.countered ? `<button class="primary small" data-a="counter">카운터 스펠: 무효화할까요?${v.you.tax ? ` (세금 ${fmt(v.you.tax)})` : ''}</button>` : ''}
      ${r.canImmune && !r.countered ? `<button class="small" data-a="immunity">면역: 나만 이 효과에서 빠지기${v.you.tax ? ` (세금 ${fmt(v.you.tax)})` : ''}</button>` : ''}
      ${
        r.steal && !r.countered
          ? `<div class="rx-steal">${r.steal
              .map(
                (o) =>
                  `<button class="small primary" data-a="steal"${o.targetId ? ` data-target="${esc(o.targetId)}"` : ''}${o.boardIndex !== undefined ? ` data-board="${o.boardIndex}"` : ''}>탈취${
                    o.targetId ? ` → ${esc(nameOf(v, o.targetId))}` : o.boardIndex !== undefined ? ` → 보드 ${o.boardIndex + 1}번째` : ''
                  }</button>`,
              )
              .join('')}</div>`
          : ''
      }
      ${r.queued ? `<div class="rx-sub">대기 중인 선언 ${r.queued}개</div>` : ''}
    </div>`;
}

function renderTable(v: PlayerView) {
  const n = v.players.length;
  // 자리에 앉지 않은 사람(중도 참여 대기 등)은 첫 좌석을 아래에 둔다
  const mySeat = Math.max(0, v.players.findIndex((p) => p.id === v.you.id));
  const seats = v.players.map((p, i) => seatHtml(v, p, (i - mySeat + n) % n, n)).join('');
  patch($('#g-seats'), seats);

  const peekAt = new Map(v.peek.map((x) => [x.index, x]));
  const slots = Array.from({ length: Math.max(5, v.board.length, ...v.peek.map((x) => x.index + 1)) }, (_, i) => {
    if (i >= v.board.length) {
      const pk = peekAt.get(i);
      // 나만 미리 본 카드: 흐릿하게 + 표시
      if (pk) return `<span class="peek-slot" title="${esc(pk.label)}: 나만 미리 본 카드 (아직 공개 전)">${cardHtml(pk.card, { size: 'md', extra: 'peek' })}<i>${esc(pk.label)}</i></span>`;
      return '<span class="card slot md"></span>';
    }
    const c = v.board[i];
    if (!c) return `<span class="card back md fog" title="짙은 안개: 쇼다운 때 공개"></span>`;
    // 봉인된 카드는 족보 계산에서 빠지므로 강조하지 않는다
    const sealed = v.sealed.includes(i);
    return cardHtml(c, { size: 'md', extra: sealed ? 'sealed' : handCardClass(v, c) });
  }).join('');
  const notes = v.table.notes.map((t) => `<span class="tnote">${esc(t)}</span>`).join('');
  // 이번 핸드의 최근 행동 몇 줄 (테이블 가운데에서 바로 보이도록)
  const feed = v.log
    .filter((e) => e.hand === v.handNumber && /: (폴드|체크|콜|레이즈|베팅|올인|강제 폴드|무임승차)|▸|비공개 증강을 사용|📢/.test(e.text))
    .slice(-3)
    .map((e, i, arr) => `<div class="feed-line${i === arr.length - 1 ? ' last' : ''}">${richText(e.text)}</div>`)
    .join('');
  const board2 = v.board2
    ? `<div class="board second">${Array.from({ length: Math.max(5, v.board2.length) }, (_, i) => {
        const c = v.board2![i];
        if (i >= v.board2!.length) return '<span class="card slot md"></span>';
        return c ? cardHtml(c, { size: 'md' }) : '<span class="card back md fog"></span>';
      }).join('')}</div>`
    : '';
  const reserved = v.reserved.filter((r) => r.index >= v.board.length);
  patch(
    $('#g-center'),
    `<div class="felt-mark">♠ 증강 홀덤 <span>레벨 ${v.level} · ${fmt(v.blinds.sb)}/${fmt(v.blinds.bb)}</span></div>
     ${notes ? `<div class="tnotes">${notes}</div>` : ''}
     <div class="board">${slots}</div>${board2}
     ${reserved.length ? `<div class="reserved">${reserved.map((r) => `<span class="res-card" title="${esc(r.label)}">${cardHtml(r.card, { size: 'sm', extra: 'inline' })} 예약</span>`).join('')}</div>` : ''}
     <div class="pot"><span class="pot-chips"></span>팟 ${v.potApprox ? '약 ' : ''}${fmt(v.pot)}</div>
     ${feed ? `<div class="feed">${feed}</div>` : ''}
     ${revealHtml()}
     ${reactionHtml(v) || `<div class="center-wait">${waitingText(v)} <span class="timer-text" data-timer></span></div>`}`,
  );

  // 핸드 결과
  const r = v.result;
  if (!r || (v.phase !== 'handEnd' && v.phase !== 'gameOver')) {
    patch($('#g-result'), '');
    return;
  }
  const entries = r.showdown
    ? r.entries
        .map((e) => {
          const tags = [
            ...e.variants.map((t) => `<em class="var">${esc(t)}</em>`),
            ...e.applied.map((t) => `<em>적용: ${esc(t)}</em>`),
            ...e.tiebreak.map((t) => `<em class="tb">${t === '순혈' ? '순혈 적용' : `${esc(t)}로 승리`}</em>`),
          ].join(' ');
          return `<div class="res-row ${e.won > 0 ? 'win' : ''}">
          <span class="nm">${esc(e.name)}</span>
          <span class="cards">${e.cards.map((c) => cardHtml(c, { size: 'sm', extra: e.bestCards.includes(c) ? '' : 'dim' })).join('')}</span>
          <span class="hn">${esc(e.handName)} ${tags}</span>
          <span class="won">${e.won > 0 ? `+${fmt(e.won)}` : ''}</span></div>`;
        })
        .join('')
    : `<div class="res-row win"><span>${esc(r.pots[0]?.winners.join(', '))}</span><span>나머지 모두 폴드</span><span class="won">+${fmt(r.pots[0]?.amount ?? 0)}</span></div>`;
  const pots = r.pots.map((p) => `<span>${esc(p.label)} ${fmt(p.amount)} → ${esc(p.winners.join(', '))}</span>`).join(' · ');
  patch(
    $('#g-result'),
    `<div class="result">
      <h4>핸드 #${r.hand} ${r.showdown ? '쇼다운' : '결과'}</h4>
      ${r.table.length ? `<div class="res-table">${r.table.map((t) => `<span>${richText(t)}</span>`).join('')}</div>` : ''}
      ${r.board.length ? `<div class="res-board">${r.board.map((c, i) => cardHtml(c, { size: 'sm', extra: r.sealed.includes(i) ? 'sealed' : '' })).join('')}</div>` : ''}
      ${entries}
      <div class="pots">${pots}</div>
      ${r.extras.map((x) => `<div class="extra">${richText(x)}</div>`).join('')}
    </div>`,
  );
}

function renderHand(v: PlayerView) {
  const me = v.players.find((p) => p.id === v.you.id);
  let html: string;
  if (v.you.joining) {
    const j = v.you.joining;
    html = `<div class="hand-info joining"><b>다음 핸드부터 참여합니다</b>
      <div>증강 선택 ${j.picksDone}/${j.picksTotal}${j.picksDone < j.picksTotal ? ' 진행 중' : ' 완료 — 다음 핸드 시작 때 자리에 앉습니다'}</div>
      <div class="muted small-note">지금은 테이블의 공개 정보만 볼 수 있습니다.</div></div>`;
  } else if (v.you.dormant !== null) {
    html = `<div class="hand-info joining"><b>부활 대기 중</b><div>핸드 #${v.you.dormant}에 원래 자리로 돌아옵니다 (3일 안에 오리라).</div>
      <div class="muted small-note">대기 중에는 테이블의 공개 정보만 볼 수 있습니다.</div></div>`;
  } else if (v.you.out || !me) {
    html = `<div class="hand-info">탈락했습니다${me?.place ? ` (${me.place}위)` : ''}. 게임은 계속 볼 수 있습니다.</div>`;
  } else {
    let cards: string;
    if (v.you.hole.length) cards = v.you.hole.map((c) => cardHtml(c, { size: 'lg', extra: me.folded ? 'dim' : handCardClass(v, c) })).join('');
    else if (v.you.holeHidden) cards = Array.from({ length: v.you.holeHidden }, () => cardBack('lg')).join('') + '<span class="muted blk">암전</span>';
    else cards = '<span class="muted">카드 없음</span>';
    html = `<div class="hole">${cards}</div>
      <div class="hand-info"><div class="chipline"><b>${fmt(v.you.chips)}</b> 칩${me.streetBet ? ` · 베팅 ${fmt(me.streetBet)}` : ''}
      ${me.folded ? ' · <span class="muted">폴드</span>' : ''}</div>
      ${handPanelHtml(v)}
      ${v.you.holeHidden && !me.folded ? '<div class="muted small-note">암전: 쇼다운까지 내 카드를 볼 수 없습니다</div>' : ''}
      ${v.you.boardBlind ? '<div class="warn">실명 다트: 이번 핸드는 보드를 볼 수 없습니다 (쇼다운 때 공개)</div>' : ''}
      ${
        v.you.extra.lockerReady
          ? `<div class="locker-row">보관함 ${cardHtml(v.you.extra.lockerReady, { size: 'sm', extra: 'inline' })}와 바꾸기: ${(v.you.hole.length ? v.you.hole : Array.from({ length: v.you.holeHidden }, () => ''))
              .map((c, i) => `<button class="small" data-a="locker" data-i="${i}">${c ? cardHtml(c, { size: 'sm', extra: 'inline' }) : `${i + 1}번`}</button>`)
              .join('')}</div>`
          : ''
      }
      ${me.sittingOut ? '<div class="warn">자리 비움 상태입니다</div>' : ''}</div>`;
  }
  patch($('#g-hand'), html);
  patch($('#g-handtable'), app.showHandTable ? handTableHtml(v) : '');
}

function renderActions(v: PlayerView) {
  const l = v.you.legal;
  const el = $('#g-actions');
  if (!l) {
    patch(el, `<div class="not-turn">${v.phase === 'betting' ? waitingText(v) : ''}</div>`);
    return;
  }
  const key = `${v.handNumber}|${v.street}|${v.currentBet}|${l.minRaiseTo}`;
  if (key !== app.raiseKey) {
    app.raiseKey = key;
    app.raise = l.minRaiseTo;
  }
  const raiseLabel = l.opening ? '베팅' : '레이즈';
  const tax = v.you.tax ? ` · 세금 ${fmt(v.you.tax)}` : '';
  const html = `<div class="my-turn-pill">내 차례!${v.you.turnCut ? ` <span class="cut">행동 시간 -${v.you.turnCut}초</span>` : ''}</div><div class="timerbar${v.you.turnCut ? ' cut' : ''}"><div class="fill" data-timerbar></div></div>
    ${l.forced ? '<div class="warn">강제 집행: 이번에는 폴드할 수 없고 콜해야 합니다</div>' : ''}
    <div class="btns">
      ${l.fold ? '<button class="fold" data-a="fold">폴드</button>' : ''}
      ${l.check ? '<button data-a="check">체크</button>' : ''}
      ${l.call ? `<button data-a="call">콜 ${fmt(l.callAmount)}${l.callAmount >= v.you.chips ? ' (올인)' : ''}</button>` : ''}
      ${l.freeRide ? `<button class="aug-btn" data-a="freeRide" title="콜 금액의 절반만 내고 콜한 것으로 처리 (3초 반응 대기)">무임승차 콜 ${fmt(l.freeRideAmount)}${tax}</button>` : ''}
      ${l.raise ? `<button class="primary" data-a="raise">${raiseLabel} <span data-raise-label></span></button>` : ''}
      ${l.allIn ? `<button class="allin" data-a="allin">올인 ${fmt(l.allInAmount)}</button>` : ''}
    </div>
    ${
      l.raise
        ? `<div class="raise-row">
      <input type="range" id="raise-range" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" step="${Math.max(1, Math.floor(v.blinds.sb))}" />
      <input type="number" id="raise-num" min="${l.minRaiseTo}" max="${l.maxRaiseTo}" />
      <span class="presets"><button class="small" data-a="preset" data-f="0.5">½팟</button><button class="small" data-a="preset" data-f="1">팟</button><button class="small" data-a="preset" data-f="min">최소</button></span>
    </div>`
        : ''
    }`;
  if (patch(el, html)) setRaise(app.raise, v);
}

function setRaise(value: number, v: PlayerView) {
  const l = v.you.legal;
  if (!l) return;
  const val = Math.max(l.minRaiseTo, Math.min(l.maxRaiseTo, Math.round(value)));
  app.raise = val;
  const range = $('#raise-range') as HTMLInputElement | null;
  const num = $('#raise-num') as HTMLInputElement | null;
  if (range && document.activeElement !== range) range.value = String(val);
  if (num && document.activeElement !== num) num.value = String(val);
  const lab = $('[data-raise-label]');
  if (lab) lab.textContent = fmt(val) + (val >= l.maxRaiseTo ? ' (올인)' : '');
}

/** 증강 사용 버튼 (못 쓰면 비활성화하고 툴팁으로 가능한 시점 안내) */
function useBtn(v: PlayerView, a: MyAugmentView, label: string, extra = ''): string {
  const tax = v.you.tax ? ` <span class="taxtag">세금 ${fmt(v.you.tax)}</span>` : '';
  return `<button class="small primary" data-a="use" data-aug="${a.id}" ${extra} ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">${label}${tax}</button>`;
}

function augControl(v: PlayerView, a: MyAugmentView): string {
  const nameOfId = (id: string) => nameOf(v, id);
  switch (a.trigger) {
    case 'passive':
      return '<span class="muted">자동 발동</span>';
    case 'window':
      return `<span class="muted" title="${esc(a.hint)}">${a.usesLeft ? '턴·리버 공개 직후 선언 기회에' : '사용함'}</span>`;
    case 'call':
      return `<span class="muted" title="${esc(a.hint)}">${a.usesLeft ? '레이즈·올인에 콜할 때 "무임승차 콜" 버튼' : '사용함'}</span>`;
    case 'reaction':
      return `<span class="muted" title="${esc(a.hint)}">${a.usesLeft ? (a.id === 'immunity' ? '다른 사람의 공개형 증강 반응 대기 중에 버튼이 나타남' : '다른 사람 증강의 반응 대기 중에 버튼이 나타남') : '사용함'}</span>`;
  }
  if (a.id === 'exemption') {
    return `<button class="small ${a.armed ? 'on' : ''}" data-a="toggle" data-on="${a.armed ? '0' : '1'}" ${a.usesLeft ? '' : 'disabled'} title="블라인드 차례에 자동 사용 (선언 → 3초 반응 대기)">자동 사용 ${a.armed ? '켜짐' : '꺼짐'}</button>`;
  }
  if (a.id === 'disguise') {
    if (!a.usesLeft) return '<span class="muted">사용함</span>';
    const ids = (Object.keys(AUGMENTS) as AugmentId[]).filter((id) => id !== 'disguise');
    const cur = a.fakeId ?? (app.fake || ids[0]);
    return `<select data-fake ${a.fakeId ? 'disabled' : ''}>${ids
      .map((id) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${AUGMENTS[id].name} ${stars(AUGMENTS[id].stars)}</option>`)
      .join('')}</select>${
      a.fakeId ? '<button class="small on" data-a="disguise" data-off="1">준비됨 · 해제</button>' : '<button class="small" data-a="disguise">준비</button>'
    }`;
  }
  if (a.id === 'mulligan') {
    if (!v.you.hole.length) return useBtn(v, a, '무작위 1장 교체', `data-i="0"`) + `<span class="muted"> (${fmt(v.blinds.bb)}칩)</span>`;
    return (
      v.you.hole
        .map((c, i) => `<button class="small" data-a="use" data-aug="mulligan" data-i="${i}" ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">${cardHtml(c, { size: 'sm', extra: 'inline' })} 교체</button>`)
        .join('') + `<span class="muted"> (${fmt(v.blinds.bb)}칩${v.you.tax ? ` + 세금 ${fmt(v.you.tax)}` : ''})</span>`
    );
  }
  if (a.id === 'shepherd') {
    const real = v.you.hole.length
      ? v.you.hole.map((c, i) => `<button class="small" data-a="use" data-aug="shepherd" data-i="${i}" ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">${cardHtml(c, { size: 'sm', extra: 'inline' })} 공개</button>`).join('')
      : useBtn(v, a, '1번 카드 공개', 'data-i="0"');
    if (a.fakeUsed) return real + '<span class="muted"> 가짜 공개 사용함</span>';
    const seen = new Set<string>([...v.you.hole, ...(v.board.filter(Boolean) as string[]), ...v.players.flatMap((p) => [...p.shepherdShown, ...(p.shownCards ?? [])])]);
    const all = 'AKQJT98765432'.split('').flatMap((r) => ['s', 'h', 'd', 'c'].map((s) => r + s)).filter((c) => !seen.has(c));
    if (!all.includes(app.fakeCard)) app.fakeCard = all[0] ?? '';
    return `${real}<span class="fakerow"><select data-fakecard>${all
      .map((c) => `<option value="${c}" ${c === app.fakeCard ? 'selected' : ''}>${c.replace('T', '10')}</option>`)
      .join('')}</select><button class="small" data-a="shepherdFake" ${a.usableNow ? '' : 'disabled'} title="게임 1회: 가짜 카드를 진짜처럼 공개 (쇼다운에서 들키면 2BB 벌금)">가짜 공개</button></span>`;
  }
  if (a.id === 'blindDraw') {
    if (!v.you.hole.length) return useBtn(v, a, '무작위 1장 교체', 'data-i="0"');
    return v.you.hole
      .map((c, i) => `<button class="small" data-a="use" data-aug="blindDraw" data-i="${i}" ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">${cardHtml(c, { size: 'sm', extra: 'inline' })} 교체</button>`)
      .join('');
  }
  if (a.id === 'radar') {
    const opts = v.board.map((c, i) => (c ? `<option value="${i}" ${i === app.radarIdx ? 'selected' : ''}>${c.replace('T', '10')}</option>` : '')).join('');
    return (opts ? `<select data-radar>${opts}</select>` : '<span class="muted">보드 없음</span>') + useBtn(v, a, '레이더');
  }
  if (a.id === 'destinyDraw') {
    const chosen = v.you.extra.destinyCard;
    if (chosen) return `<span class="muted">다음 핸드에 ${cardHtml(chosen, { size: 'sm', extra: 'inline' })} 받음</span>`;
    return `<button class="small primary" data-a="destinyOpen" ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">카드 고르기</button>`;
  }
  if (a.id === 'bet') {
    const pred = v.you.extra.betPrediction;
    if (pred !== null) return `<span class="muted">예측: ${esc(BET_NAMES[pred])}</span>`;
    return `<button class="small primary" data-a="betOpen" ${a.usableNow ? '' : 'disabled'} title="${esc(a.hint)}">족보 예측</button>`;
  }
  if (a.id === 'rumor') {
    const ids = Object.keys(AUGMENTS) as AugmentId[];
    return `<select data-rumor>${ids.map((id) => `<option value="${id}" ${id === app.rumor ? 'selected' : ''}>${esc(AUGMENTS[id].name)}</option>`).join('')}</select>${useBtn(v, a, '소문 내기')}`;
  }
  if (a.id === 'parity') return `<span class="muted">${a.parity === 'even' ? '짝수 동맹' : '홀수 동맹'} · 자동 발동</span>`;
  if (a.target) {
    const opts = a.targets;
    if (!opts.includes(app.targets[a.id])) app.targets[a.id] = opts[0] ?? '';
    const sel = opts.length
      ? `<select data-target="${a.id}">${opts.map((id) => `<option value="${esc(id)}" ${id === app.targets[a.id] ? 'selected' : ''}>${esc(nameOfId(id))}</option>`).join('')}</select>`
      : '<span class="muted">대상 없음</span>';
    return sel + useBtn(v, a, '사용');
  }
  const labels: Partial<Record<AugmentId, string>> = {
    foresight: '다음 카드 보기',
    blank: '비공개 증강 알림 보내기',
    blackout: '다음 핸드 암전 선언',
    glassTable: '유리 테이블 선언',
    russianRoulette: '러시안 룰렛 선언',
    heavyFog: '짙은 안개 선언',
    deathTax: '죽음과 세금 선언',
    colorForecast: '다음 카드 무늬 보기',
    leaderboard: '내 순위 보기',
    circuitBreaker: '서킷브레이커 선언',
    ironWall: '철벽 선언',
    padlock: '자물쇠 선언',
    bombPot: '다음 핸드 폭탄 팟 선언',
    underdog: '언더독 선언',
    highCardDuel: '하이카드 선언',
    restart: '나 다시 돌아갈래',
  };
  return useBtn(v, a, labels[a.id] ?? '사용');
}

const BET_NAMES = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드 이상'];

function renderAugments(v: PlayerView) {
  const list = v.you.augments;
  const html = list.length
    ? list
        .map((a) => {
          const uses =
            a.maxUses !== null ? `남은 ${a.usesLeft ?? 0}/${a.maxUses}회` : a.perHand ? `핸드당 1회${a.usedThisHand ? ' (사용함)' : ''}` : '패시브';
          const pub = a.revealed
            ? `<span class="tag pubtag">공개됨${a.publicName && a.publicName !== a.name ? ` · 상대에게는 ${esc(a.publicName)}` : ''}</span>`
            : '<span class="tag">비공개</span>';
          const kind =
            (a.public ? '<span class="tag pubkind">공개형</span>' : a.disclosure === 'anonymous' ? '<span class="tag">익명 알림</span>' : '') +
            (a.hidden ? '<span class="tag" title="잠복: 상대의 보유 수·탐문에서 빠짐, 처음 쓰면 드러남">숨김</span>' : '') +
            (v.you.extra.lurkChoose && a.id !== 'lurk' && !a.hidden ? ` <button class="small" data-a="lurk" data-aug="${a.id}" title="잠복: 이 증강을 대신 숨김 (다음 핸드 시작 전까지)">숨기기</button>` : '');
          return `<div class="aug s${a.stars}" title="${esc(a.hint)}">
            <div class="aug-head"><span class="st">${stars(a.stars)}</span><span class="cat">${esc(a.category)}</span></div>
            <div class="aug-name">${esc(a.name)}${a.wildRank ? ` <span class="wild">와일드 ${esc(a.wildRank)}</span>` : ''}</div>
            <div class="aug-desc">${esc(a.description)}</div>
            <div class="aug-meta">${uses} ${pub} ${kind}</div>
            <div class="aug-ctrl">${augControl(v, a)}</div>
            ${a.trigger === 'button' && !a.usableNow ? `<div class="aug-hint">${esc(a.hint)}</div>` : ''}
          </div>`;
        })
        .join('')
    : '<div class="muted empty">보유한 증강이 없습니다</div>';
  patch($('#g-augs'), html + infoCardHtml(v));
}

/** 핸드 정보 카드: 내 칩(BB 환산), 포지션, 팟 오즈, 다음 블라인드 (모두 내가 볼 수 있는 정보로 계산) */
function infoCardHtml(v: PlayerView): string {
  const me = v.players.find((p) => p.id === v.you.id);
  const bb = v.blinds.bb;
  const pos = !me ? '관전' : me.isDealer ? '딜러' : me.isSB ? '스몰 블라인드' : me.isBB ? '빅 블라인드' : me.inHand ? '일반' : '-';
  const l = v.you.legal;
  const odds = l?.call && l.callAmount > 0 ? Math.round((l.callAmount / (v.pot + l.callAmount)) * 100) : null;
  const live = v.players.filter((p) => !p.out && !p.kicked);
  const avg = live.length ? Math.round(live.reduce((s, p) => s + p.chips, 0) / live.length) : 0;
  const rows = [
    ['내 칩', `${fmt(v.you.chips)} <span class="muted">(${Math.floor(v.you.chips / bb)}BB)</span>`],
    ['포지션', pos],
    ['팟 오즈', odds !== null ? `콜 ${fmt(l!.callAmount)} → 필요 승률 ${odds}%` : '<span class="muted">-</span>'],
    ['평균 칩', `${v.potApprox ? '약 ' : ''}${fmt(avg)}`],
    ['다음 레벨', `${Math.max(0, v.handsUntilLevelUp)}핸드 뒤`],
  ];
  return `<div class="aug info-card"><div class="aug-head"><span class="st">ⓘ</span><span class="cat">핸드 정보</span></div>
    ${rows.map(([k, val]) => `<div class="info-row"><span class="muted">${k}</span><span>${val}</span></div>`).join('')}</div>`;
}

function countingHtml(v: PlayerView): string {
  const c = v.you.counting;
  if (!c) return '';
  const unseen = new Set(c.unseen);
  const ranks = 'AKQJT98765432'.split('');
  const grid = ['s', 'h', 'd', 'c']
    .map(
      (s) =>
        `<div class="cg-row"><span class="cg-suit ${s === 'h' || s === 'd' ? 'red' : ''}">${{ s: '♠', h: '♥', d: '♦', c: '♣' }[s]}</span>${ranks
          .map((r) => `<span class="cg ${unseen.has(r + s) ? '' : 'seen'} ${c.outCards?.includes(r + s) ? 'out' : ''}">${r === 'T' ? '10' : r}</span>`)
          .join('')}</div>`,
    )
    .join('');
  const kindName: Record<string, string> = { burn: '번', fold: '폴드', discard: '버림', rewind: '되감기', shown: '공개 후 버림', called: '명추리로 공개' };
  const used = c.used.length
    ? c.used.map((u) => `<span class="cu">${cardHtml(u.card, { size: 'sm', extra: 'inline' })}<i>${kindName[u.kind] ?? ''}</i></span>`).join('')
    : '<span class="muted">아직 없음</span>';
  const outs =
    c.outCards !== null
      ? `<div>아웃츠 <b>${c.outCards.length}</b>장 · 리버까지 완성 확률 <b>${Math.round((c.completion ?? 0) * 100)}%</b> <span class="muted">(남은 ${c.unseen.length}장 기준)</span></div>`
      : `<div class="muted">남은 카드 ${c.unseen.length}장 (아웃츠는 플랍·턴에 표시)</div>`;
  return `<div class="counting"><h4>카운팅</h4>${outs}<div class="cused">사용된 카드: ${used}</div><div class="cgrid">${grid}</div></div>`;
}

function renderNotes(v: PlayerView) {
  const notes = v.you.notes;
  const x = v.you.extra;
  const status = [
    x.lateLosses !== null ? `왕귀: 쇼다운 패배 ${x.lateLosses}회${x.lateLosses >= 3 ? ' (다음 승리 때 발동)' : ''}` : '',
    x.betPrediction !== null ? `내기할래? 예측: ${BET_NAMES[x.betPrediction]}` : '',
    x.destinyCard ? `데스티니 드로우: 다음 핸드 [${x.destinyCard}]` : '',
    x.ironWall ? '철벽: 이번 핸드 지목 불가' : '',
    x.blackjackOn ? '블랙잭 발동 중' : '',
  ].filter(Boolean);
  const statusHtml = status.length ? `<div class="notes"><h4>내 증강 상태</h4>${status.map((t) => `<div class="note info">${richText(t)}</div>`).join('')}</div>` : '';
  const noteHtml = notes.length
    ? `<div class="notes"><h4>나만 아는 정보</h4>${notes
        .slice(-8)
        .map((n) => {
          const i = n.text.indexOf(':');
          const title = i > 0 ? n.text.slice(0, i) : '';
          const body = i > 0 ? n.text.slice(i + 1).trim() : n.text;
          const big = n.cards?.length && n.hand === v.handNumber ? `<span class="note-cards">${n.cards.map((c) => cardHtml(c, { size: 'sm' })).join('')}</span>` : '';
          return `<div class="note k-${n.kind}">${title ? `<b class="note-title">${esc(title)}</b>` : ''}${big}<span class="note-body">${richText(body)}</span>${n.hand !== v.handNumber ? ` <span class="muted">(#${n.hand})</span>` : ''}</div>`;
        })
        .join('')}</div>`
    : '';
  patch($('#g-notes'), statusHtml + noteHtml + countingHtml(v));
}

function renderLog(v: PlayerView) {
  const el = $('#g-log')!;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const html = v.log.map((e) => `<div class="le${e.text.startsWith('──') ? ' sep' : ''}">${richText(e.text)}</div>`).join('');
  if (patch(el, html) && (nearBottom || app.lastLogSeq === 0)) el.scrollTop = el.scrollHeight;
  app.lastLogSeq = v.log.at(-1)?.seq ?? 0;
}

/** 내기할래? 선택 창: 버튼을 눌렀거나, 프리플랍 내 첫 행동 차례에 아직 예측하지 않았을 때 (건너뛸 수 있음) */
function betPromptOpen(v: PlayerView): boolean {
  const bet = v.you.augments.find((a) => a.id === 'bet');
  if (!bet || !bet.usableNow || v.you.extra.betPrediction !== null) {
    app.betOpen = false;
    return false;
  }
  return app.betOpen || (!!v.you.legal && v.street === 'preflop' && app.betSkipHand !== v.handNumber);
}

function renderModal(env: GameEnvelope, v: PlayerView) {
  const el = $('#modal');
  const you = v.you;
  let html = '';
  if (you.pick && you.pick.length) {
    html = `<div class="modal-bg"><div class="modal pick">
      <h3>증강 선택 <span class="timer-text" data-timer></span></h3>
      <p class="muted">레벨 ${v.level} · 하나를 고르세요. 시간이 지나면 무작위로 선택됩니다.${you.joining ? ` <b>중도 참여 선택 ${you.joining.picksDone + 1}/${you.joining.picksTotal}</b>` : ''}${you.pickExtra ? ` <b class="streak">폭주기관차: 이 선택지에서 ${you.pickExtra + 1}개를 가져갑니다</b>` : ''}</p>
      <div class="pick-row">${you.pick
        .map((a) =>
          a.id === 'parity'
            ? `<div class="pick-card s${a.stars}">
          <div class="big-stars">${stars(a.stars)}</div>
          <div class="pc-name">${esc(a.name)}</div>
          <div class="pc-cat">${esc(a.category)}</div>
          <div class="pc-desc">${esc(a.description)}</div>
          <div class="pc-choice"><button class="small primary" data-a="pick" data-aug="parity" data-parity="even">짝수로</button><button class="small primary" data-a="pick" data-aug="parity" data-parity="odd">홀수로</button></div></div>`
            : `<button class="pick-card s${a.stars}" data-a="pick" data-aug="${a.id}">
          <div class="big-stars">${stars(a.stars)}</div>
          <div class="pc-name">${esc(a.name)}</div>
          <div class="pc-cat">${esc(a.category)}</div>
          <div class="pc-desc">${esc(a.description)}</div></button>`,
        )
        .join('')}</div></div></div>`;
  } else if (app.showSettings) {
    html = `<div class="modal-bg"><div class="modal settings-modal">
      <h3>${env.youAreHost ? '방 설정' : '방 설정 (읽기 전용)'}</h3>
      <div class="settings">${env.youAreHost ? settingsForm(env.settings, env, 0, true) : settingsSummary(env.settings, null)}</div>
      <p class="muted small-note">게임 중에는 시작 칩·블라인드·상승 방식을 바꿀 수 없습니다.</p>
      ${env.youAreHost ? giveHostHtml(v) : ''}
      <div class="lobby-actions"><button data-a="settings">닫기</button></div></div></div>`;
  } else if (v.reaction) {
    html = '';
  } else if (v.respond?.needMe && v.respond.input) {
    html = respondModalHtml(v);
  } else if (you.discard?.pending) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>세 번째 손: 버릴 카드 1장 <span class="timer-text" data-timer></span></h3>
      <div class="board-mini">플랍 ${v.board.map((c) => (c ? cardHtml(c, { size: 'md' }) : cardBack('md'))).join('')}</div>
      <div class="choose-row">${you.hole
        .map((c, i) => `<button class="card-btn" data-a="discard" data-i="${i}">${cardHtml(c, { size: 'lg' })}<span>버리기</span></button>`)
        .join('')}</div>
      <p class="muted">모든 사람이 결정하면 한 번에 처리됩니다.</p></div></div>`;
  } else if (you.declare) {
    const opts = you.declare.options;
    const seal = opts.find((o) => o.id === 'seal');
    const fork = opts.find((o) => o.id === 'lastFork');
    const tax = you.tax ? ` <span class="taxtag">세금 ${fmt(you.tax)}</span>` : '';
    html = `<div class="modal-bg"><div class="modal">
      <h3>선언 기회 (${v.street === 'turn' ? '턴' : '리버'} 공개 직후) <span class="timer-text" data-timer></span></h3>
      <p class="muted">내 카드 ${you.hole.length ? you.hole.map((c) => cardHtml(c, { size: 'sm', extra: 'inline' })).join('') : '(암전)'} · 선언하면 3초 반응 대기 후 적용됩니다.</p>
      ${opts
        .filter((o) => o.id !== 'seal' && o.id !== 'lastFork')
        .map((o) => `<div class="decl-row"><button class="primary" data-a="declare" data-aug="${o.id}">${esc(o.name)} 선언${tax}</button> <span class="muted">${esc(o.description)}</span></div>`)
        .join('')}
      ${
        seal
          ? `<div class="decl-row"><b>봉인</b> <span class="muted">족보 계산에서 뺄 보드 카드를 고르세요 (모든 플레이어에게 적용)</span></div>
        <div class="choose-row">${v.board
          .map((c, i) =>
            v.sealed.includes(i)
              ? `<span class="card-btn off">${c ? cardHtml(c, { size: 'lg', extra: 'sealed' }) : cardBack('lg')}<span>봉인됨</span></span>`
              : `<button class="card-btn" data-a="declare" data-aug="seal" data-i="${i}">${c ? cardHtml(c, { size: 'lg' }) : cardBack('lg')}<span>봉인${tax}</span></button>`,
          )
          .join('')}</div>`
          : ''
      }
      ${
        fork
          ? `<div class="decl-row"><b>마지막 갈림길</b> <span class="muted">공개하고 버릴 홀카드를 고르세요 (새 카드는 나만 봄)</span></div>
        <div class="choose-row">${(you.hole.length ? you.hole : Array.from({ length: you.holeHidden }, () => ''))
          .map((c, i) => `<button class="card-btn" data-a="declare" data-aug="lastFork" data-i="${i}">${c ? cardHtml(c, { size: 'lg' }) : cardBack('lg')}<span>버리기${tax}</span></button>`)
          .join('')}</div>`
          : ''
      }
      <button data-a="declare" data-aug="">선언하지 않음</button></div></div>`;
  } else if (you.attach) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>애착: 다음 핸드로 가져갈 카드 <span class="timer-text" data-timer></span></h3>
      <p class="muted">고르지 않으면 높은 카드를 가져갑니다.</p>
      <div class="choose-row">${you.attach.cards
        .map((c, i) => `<button class="card-btn" data-a="attach" data-i="${i}">${cardHtml(c, { size: 'lg' })}<span>가져가기</span></button>`)
        .join('')}</div></div></div>`;
  } else if (you.extra.lockerChoose) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>보관함: 보관할 홀카드 <span class="timer-text" data-timer></span></h3>
      <p class="muted">다음 핸드 프리플랍에 홀카드 1장과 바꿀 수 있습니다. 고르지 않으면 높은 카드를 보관합니다.</p>
      <div class="choose-row">${you.extra.lockerChoose
        .map((c, i) => `<button class="card-btn" data-a="locker" data-i="${i}">${cardHtml(c, { size: 'lg' })}<span>보관</span></button>`)
        .join('')}</div></div></div>`;
  } else if (you.extra.showChoose) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>쇼맨십: 홀카드를 공개할까요? <span class="timer-text" data-timer></span></h3>
      <p class="muted">공개하면 마지막으로 폴드한 상대에게서 1BB, 하이카드(블러프)였다면 2BB를 받습니다.</p>
      <div class="choose-row">${you.hole.map((c) => cardHtml(c, { size: 'lg' })).join('')}</div>
      <div class="lobby-actions"><button class="primary" data-a="show" data-reveal="1">공개하기</button><button data-a="show" data-reveal="0">공개하지 않음</button></div></div></div>`;
  } else if (you.extra.eitherOr && you.extra.eitherOr.pick === null && v.street === 'flop') {
    html = `<div class="modal-bg"><div class="modal">
      <h3>양자택일: 턴 카드 고르기</h3>
      <p class="muted">고른 카드가 턴에 공개되고 나머지는 버립니다. 턴이 공개되기 전까지 고르지 않으면 첫 번째 카드입니다.</p>
      <div class="choose-row">${you.extra.eitherOr.cards
        .map((c, i) => `<button class="card-btn" data-a="eitherOr" data-i="${i}">${cardHtml(c, { size: 'lg' })}<span>턴으로</span></button>`)
        .join('')}</div></div></div>`;
  } else if (app.destinyOpen) {
    const blocked = new Set(you.extra.destinyBlocked);
    const grid = ['s', 'h', 'd', 'c']
      .map(
        (su) =>
          `<div class="dd-row">${'AKQJT98765432'
            .split('')
            .map((r) => {
              const c = r + su;
              return blocked.has(c)
                ? `<span class="dd-card off" title="고를 수 없는 카드">${cardHtml(c, { size: 'md' })}</span>`
                : `<button class="dd-card" data-a="destiny" data-card="${c}">${cardHtml(c, { size: 'md' })}</button>`;
            })
            .join('')}</div>`,
      )
      .join('');
    html = `<div class="modal-bg"><div class="modal destiny">
      <h3>데스티니 드로우: 다음 핸드에 받을 카드</h3>
      <p class="muted">고른 카드는 나만 압니다. 다른 사람이 애착·보관함으로 가져온 카드는 고를 수 없습니다(회색은 내가 이미 가져가는 카드).${you.tax ? ` 세금 ${fmt(you.tax)}` : ''}</p>
      <div class="dd-grid">${grid}</div>
      <div class="lobby-actions"><button data-a="destinyClose">닫기</button></div></div></div>`;
  } else if (betPromptOpen(v)) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>내기할래? 이번 핸드의 우승 족보 예측</h3>
      <p class="muted">쇼다운까지 가서 졌는데 예측이 맞으면 낸 칩의 50%를 팟에서 돌려받습니다. 예측은 나만 봅니다.${you.tax ? ` 세금 ${fmt(you.tax)}` : ''}</p>
      <div class="bet-row">${BET_NAMES.map((n, i) => `<button class="small primary" data-a="bet" data-choice="${i}">${esc(n)}</button>`).join('')}</div>
      <div class="lobby-actions"><button data-a="betSkip">건너뛰기</button></div></div></div>`;
  } else if (v.phase === 'gameOver') {
    const ranking = [...v.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    html = `<div class="modal-bg"><div class="modal">
      <h3>🏆 ${esc(nameOf(v, v.winnerId))} 우승!</h3>
      <ol class="ranking">${ranking.filter((p) => !p.kicked).map((p) => `<li>${esc(p.name)} <span class="muted">${p.place ?? '-'}위</span></li>`).join('')}</ol>
      <div class="lobby-actions">${env.youAreHost ? '<button class="primary" data-a="toLobby">같은 멤버로 대기실로</button>' : '<span class="muted">방장이 대기실로 돌아갈 수 있습니다.</span>'}
      <button data-a="leave">나가기</button></div></div></div>`;
  } else if (v.phase === 'augmentSelect' && you.pickDone && !you.out) {
    html = `<div class="banner">다른 플레이어가 증강을 고르는 중… <span class="timer-text" data-timer></span></div>`;
  }
  // 설정 입력 중에는 다시 그리지 않는다
  if (typingIn(el?.querySelector('.settings-modal'))) return;
  if (html.includes('respond-modal') && typingIn(el?.querySelector('.respond-modal'))) return;
  patch(el, html);
}

/** 게임 중 방장 넘기기: 접속 중인 다른 사람 목록 */
function giveHostHtml(v: PlayerView): string {
  const cands = v.players.filter((p) => !p.isBot && p.connected && !p.kicked && p.id !== v.you.id);
  if (!cands.length) return '';
  return `<div class="give-host"><b>방장 넘기기</b> ${cands
    .map((p) => `<button class="small" data-a="giveHost" data-id="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}</button>`)
    .join('')}</div>`;
}

/** 제안·입찰·비공개 선언 응답 창 (15초, 응답하지 않으면 기본 응답) */
function respondModalHtml(v: PlayerView): string {
  const r = v.respond!;
  const hole = v.you.hole.length ? v.you.hole : Array.from({ length: v.you.holeHidden }, () => '');
  const holeBtn = (label: string, extra = '') =>
    hole.map((c, i) => `<button class="card-btn" data-a="respond" data-i="${i}" ${extra}>${c ? cardHtml(c, { size: 'lg' }) : cardBack('lg')}<span>${label}</span></button>`).join('');
  const bidInput = `<div class="bid-row"><input type="number" id="bid-num" min="${r.minBid}" max="${r.maxBid}" step="${r.minBid}" value="${Math.min(r.maxBid, r.minBid)}" />
      <span class="muted">최소 ${fmt(r.minBid)} · 최대 ${fmt(r.maxBid)}</span></div>`;
  let body = '';
  switch (r.input) {
    case 'accept':
      body = `<div class="lobby-actions"><button class="primary" data-a="respond" data-accept="1">수락</button><button data-a="respond" data-accept="0">거절</button></div>`;
      break;
    case 'card':
      body = `<div class="choose-row">${holeBtn('건네기')}</div>`;
      break;
    case 'bid':
      body = `${bidInput}<div class="lobby-actions"><button class="primary" data-a="respondBid">입찰</button><button data-a="respond" data-bid="0">불참</button></div>`;
      break;
    case 'bidCard':
      body = `${v.auctionCard ? `<div class="board-mini">경매 카드 ${cardHtml(v.auctionCard, { size: 'lg' })}</div>` : ''}${bidInput}
        <p class="muted">낙찰되면 바꿀 홀카드를 눌러 입찰하세요.</p>
        <div class="choose-row">${holeBtn('이 카드와 바꾸기', 'data-bidcard="1"')}</div>
        <div class="lobby-actions"><button data-a="respond" data-bid="0">불참</button></div>`;
      break;
    case 'strongWeak':
      body = `<div class="lobby-actions"><button class="primary" data-a="respond" data-choice="1">강함</button><button data-a="respond" data-choice="0">약함</button></div>`;
      break;
  }
  return `<div class="modal-bg"><div class="modal respond-modal">
      <h3>${esc(r.name)} <span class="timer-text" data-timer></span></h3>
      <p>${richText(r.text)}</p>
      <p class="muted small-note">응답은 나만 봅니다. 시간이 지나면 ${r.input === 'accept' ? '거절' : r.input === 'card' || r.input === 'strongWeak' ? '무작위로 정합니다' : '불참'}.</p>
      ${body}</div></div>`;
}

// ───────── 디버그 패널 (서버가 DEBUG 모드일 때만 표시; 실제 차단은 서버에서) ─────────

function renderDebug() {
  const el = $('#g-debug');
  const env = app.env;
  if (!el || !env?.debug) {
    if (el) el.innerHTML = '';
    return;
  }
  // 틀(details)은 한 번만 만들고, 안쪽 영역만 갱신한다 (열림 상태·입력값 유지)
  if (!el.querySelector('details.debug')) {
    el.innerHTML = `<details class="debug"><summary>디버그</summary>
      <label class="check"><input type="checkbox" data-dbg="reveal" /> 모든 카드·증강 공개</label>
      <div id="dbg-reveal"></div><div id="dbg-controls"></div></details>`;
  }
  const v = env.view;
  const ids = Object.keys(AUGMENTS) as AugmentId[];
  const d = app.revealAll ? app.debug : null;
  const cb = el.querySelector('[data-dbg="reveal"]') as HTMLInputElement;
  cb.checked = app.revealAll;
  const sm = (cs: string[]) => cs.map((c) => cardHtml(c, { size: 'sm', extra: 'inline' })).join('');
  patch(
    $('#dbg-reveal'),
    d
      ? `<div class="dbg-view">
      <div>보드(전체): ${d.board.map((c, i) => cardHtml(c, { size: 'sm', extra: `inline ${i < d.boardRevealed ? '' : 'dim'}` })).join('')} · 번: ${sm(d.burns)}</div>
      ${d.players
        .map(
          (p) => `<div><b>${esc(p.name)}</b> ${sm(p.hole)}
          ${p.discarded.length ? `<span class="muted">버림 ${sm(p.discarded)}</span>` : ''}${p.keptCard ? ` <span class="muted">애착 ${sm([p.keptCard])}</span>` : ''}${p.shepherdLied ? ' <span class="warn">가짜 공개</span>' : ''}
          <div class="muted">${p.augments
            .map(
              (a) =>
                `${esc(a.name)}${a.wildRank ? `(${esc(a.wildRank)})` : ''}${a.parity ? `(${a.parity === 'even' ? '짝수' : '홀수'})` : ''}${a.usesLeft !== null ? `[${a.usesLeft}]` : ''}${a.revealed ? `✓${a.publicName !== a.name ? `→${esc(a.publicName)}` : ''}` : ''}${a.armed ? '⚡' : ''}${a.fakeId ? `(위장:${esc(AUGMENTS[a.fakeId].name)})` : ''}`,
            )
            .join(', ')}</div></div>`,
        )
        .join('')}
      ${d.reaction.length ? `<div>반응 대기: ${d.reaction.map((r) => `${esc(nameOf(v, r.owner))}의 ${esc(r.augment)}${r.countered ? '(무효)' : ''}`).join(', ')}</div>` : ''}
      <div class="muted">덱 위 10장: ${sm(d.deck.slice(0, 10))}</div>
    </div>`
      : '',
  );
  const active = document.activeElement;
  const controls = $('#dbg-controls');
  if (active && controls?.contains(active)) return; // 입력 중에는 건드리지 않는다
  const playerOpts = v.players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  patch(
    controls,
    `<div class="dbg-row"><select id="dbg-player">${playerOpts}</select>
      <select id="dbg-aug">${ids.map((id) => `<option value="${id}">${AUGMENTS[id].name} ${stars(AUGMENTS[id].stars)}</option>`).join('')}</select>
      <input id="dbg-wild" placeholder="편애 2~14 / 동맹 짝·홀" size="10" />
      <button class="small" data-a="dbgGive">증강 지급</button></div>
    <div class="dbg-row"><input id="dbg-chips" placeholder="칩" size="6" /><button class="small" data-a="dbgChips">칩 설정</button>
      <button class="small" data-a="dbgLevel">블라인드 레벨 즉시 올리기</button>
      <button class="small" data-a="dbgDisconnect">선택한 플레이어 연결 끊기</button></div>
    <div class="dbg-deal">
      <div class="muted">다음 핸드 카드 지정 (예: As Kd 7c)</div>
      <label>보드 <input id="dbg-board" placeholder="최대 5장" /></label>
      ${v.players.filter((p) => !p.out).map((p) => `<label>${esc(p.name)} <input data-dbg-hand="${esc(p.id)}" placeholder="2~3장" /></label>`).join('')}
      <label>번 카드 <input id="dbg-burns" placeholder="플랍·턴·리버 앞, 최대 3장" /></label>
      <label>덱 순서 <input id="dbg-deck" placeholder="남은 덱 맨 위부터 (멀리건·되감기)" /></label>
      <button class="small" data-a="dbgDeal">다음 핸드에 적용</button>
    </div>`,
  );
}

// ───────── 타이머 표시 ─────────

function tick() {
  if (app.bubbles.size) {
    const now = Date.now();
    let expired = false;
    for (const [id, b] of app.bubbles) {
      if (b.until > now) continue;
      app.bubbles.delete(id);
      expired = true;
    }
    if (expired && app.screen === 'game' && app.env) renderTable(app.env.view);
  }
  // 좌석 위 행동 표시가 끝나면 다시 그린다
  if (app.flashes.size) {
    const now = Date.now();
    let expired = false;
    for (const [id, f] of app.flashes) {
      if (f.until > now) continue;
      app.flashes.delete(id);
      expired = true;
    }
    if (expired && app.screen === 'game' && app.env) renderTable(app.env.view);
  }
  const ms = remainingMs();
  const text = ms === null ? '' : `${Math.ceil(ms / 1000)}초`;
  // 내 차례 남은 시간이 5초 아래면 1초마다 짧은 경고음
  if (ms !== null && app.env?.view.toActId === app.env?.view.you.id && ms < 5000) {
    const sec = Math.ceil(ms / 1000);
    if (sec !== app.lastTickSec && sec > 0) {
      app.lastTickSec = sec;
      play('tick');
    }
  }
  const seatBar = $('[data-seat-timer]');
  if (seatBar && app.env && ms !== null && app.env.deadline) {
    const total = Math.max(1, app.env.deadline - app.env.serverNow);
    seatBar.style.width = `${Math.min(100, (ms / total) * 100)}%`;
  }
  document.querySelectorAll('[data-timer]').forEach((el) => {
    if (el.textContent !== text) el.textContent = text;
  });
  const bar = $('[data-timerbar]');
  const env = app.env;
  if (bar && env && ms !== null && env.deadline) {
    const total = Math.max(1, env.deadline - env.serverNow);
    bar.style.width = `${Math.min(100, (ms / total) * 100)}%`;
    bar.classList.toggle('low', ms < 5000);
  }
}
setInterval(tick, 250);

// ───────── 입력 처리 ─────────

document.addEventListener('click', async (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
  if (!t || (t as HTMLButtonElement).disabled) return;
  const a = t.dataset.a!;
  const v = app.env?.view;
  switch (a) {
    case 'create':
      return homeEnter('create');
    case 'join':
      return homeEnter('join');
    case 'joinList':
      return homeEnter('join', t.dataset.code);
    case 'mute':
      setMuted(!isMuted());
      if (!isMuted()) play('check');
      if (app.env) renderGame();
      return;
    case 'roomsRefresh': {
      const r = await send('rooms:watch', { on: true });
      app.watchingRooms = r.ok;
      toast(r.ok ? '공개 방 목록을 새로고침했습니다.' : (r.error ?? '새로고침하지 못했습니다.'));
      return;
    }
    case 'reconnect':
      app.forcedOff = false;
      socket.connect();
      return;
    case 'settings':
      app.showSettings = !app.showSettings;
      if (app.env) renderGame();
      return;
    case 'giveHost': {
      if (!confirm(`${t.dataset.name}님에게 방장을 넘길까요?`)) return;
      const r = await send('room:host', { playerId: t.dataset.id });
      if (!r.ok) toast(r.error ?? '방장을 넘기지 못했습니다.');
      else app.showSettings = false;
      if (app.env) renderGame();
      return;
    }
    case 'kick': {
      if (!confirm(`${t.dataset.name}님을 추방할까요? 진행 중인 핸드는 폴드 처리되고, 핸드가 끝나면 남은 칩과 함께 자리에서 사라집니다.`)) return;
      const r = await send('room:kick', { playerId: t.dataset.id });
      if (!r.ok) toast(r.error ?? '추방하지 못했습니다.');
      return;
    }
    case 'dbgDisconnect': {
      const r = await send('debug:disconnect', { playerId: ($('#dbg-player') as HTMLSelectElement).value });
      toast(r.ok ? '연결을 끊었습니다.' : (r.error ?? '실패'));
      return;
    }
    case 'resumeLast': {
      const last = readSeat(localStorage, LAST_KEY);
      if (last) resume(last, false);
      return;
    }
    case 'sideTab':
      app.sideTab = t.dataset.tab === 'chat' ? 'chat' : 'log';
      if (app.sideTab === 'chat') app.unread = 0;
      renderChat();
      if (app.sideTab === 'chat') {
        const list = $('#g-chat');
        if (list) list.scrollTop = list.scrollHeight;
        ($('.side .chat-form input') as HTMLInputElement | null)?.focus();
      }
      return;
    case 'handTable':
      app.showHandTable = !app.showHandTable;
      if (app.env) renderGame();
      return;
    case 'copy':
      return copyLink(app.lobby?.code ?? app.env?.code ?? '');
    case 'start': {
      const r = await send('room:start');
      if (!r.ok) toast(r.error ?? '시작할 수 없습니다.');
      return;
    }
    case 'leave': {
      if (app.screen === 'game' && app.env?.view.phase !== 'gameOver' && !confirm('게임에서 나가면 다시 돌아올 수 없고, 남은 칩은 블라인드로 계속 빠집니다. 나갈까요?')) return;
      await send('room:leave');
      forgetSeat();
      app.lobby = null;
      app.env = null;
      app.chat = [];
      app.unread = 0;
      app.bubbles.clear();
      app.showSettings = false;
      app.screen = 'home';
      history.replaceState(null, '', location.pathname);
      render();
      return;
    }
    case 'toLobby': {
      const r = await send('room:lobby');
      if (!r.ok) toast(r.error ?? '실패');
      return;
    }
    case 'fold':
    case 'check':
    case 'call':
    case 'allin':
      return act({ type: a });
    case 'raise':
      return act({ type: 'raise', amount: app.raise });
    case 'preset': {
      if (!v?.you.legal) return;
      const f = t.dataset.f!;
      const l = v.you.legal;
      // 팟 레이즈: 콜한 뒤의 팟 크기만큼 더 올림
      const target = f === 'min' ? l.minRaiseTo : v.currentBet + Math.round((v.pot + l.callAmount) * Number(f));
      setRaise(target, v);
      return;
    }
    case 'pick':
      return act({ type: 'pick', augment: t.dataset.aug, parity: t.dataset.parity });
    case 'immunity':
      return act({ type: 'immunity' });
    case 'locker':
      return act({ type: 'locker', cardIndex: Number(t.dataset.i) });
    case 'show':
      return act({ type: 'show', reveal: t.dataset.reveal === '1' });
    case 'eitherOr':
      return act({ type: 'eitherOr', pick: Number(t.dataset.i) });
    case 'destinyOpen':
      app.destinyOpen = true;
      if (app.env) renderGame();
      return;
    case 'destinyClose':
      app.destinyOpen = false;
      if (app.env) renderGame();
      return;
    case 'destiny':
      app.destinyOpen = false;
      return act({ type: 'useAugment', augment: 'destinyDraw', card: t.dataset.card });
    case 'betOpen':
      app.betOpen = true;
      if (app.env) renderGame();
      return;
    case 'betSkip':
      app.betOpen = false;
      app.betSkipHand = v?.handNumber ?? -1;
      if (app.env) renderGame();
      return;
    case 'bet':
      app.betOpen = false;
      return act({ type: 'useAugment', augment: 'bet', choice: Number(t.dataset.choice) });
    case 'discard':
      return act({ type: 'discard', cardIndex: Number(t.dataset.i) });
    case 'lurk':
      return act({ type: 'lurk', augment: t.dataset.aug });
    case 'respond': {
      const bidNow = () => Number(($('#bid-num') as HTMLInputElement | null)?.value ?? 0);
      if (t.dataset.accept !== undefined) return act({ type: 'respond', accept: t.dataset.accept === '1' });
      if (t.dataset.choice !== undefined) return act({ type: 'respond', choice: Number(t.dataset.choice) });
      if (t.dataset.bid !== undefined) return act({ type: 'respond', bid: Number(t.dataset.bid) });
      if (t.dataset.bidcard) return act({ type: 'respond', bid: bidNow(), cardIndex: Number(t.dataset.i) });
      return act({ type: 'respond', cardIndex: Number(t.dataset.i) });
    }
    case 'respondBid':
      return act({ type: 'respond', bid: Number(($('#bid-num') as HTMLInputElement | null)?.value ?? 0) });
    case 'declare': {
      const aug = t.dataset.aug || null;
      const i = t.dataset.i !== undefined ? Number(t.dataset.i) : undefined;
      return act({ type: 'declare', augment: aug, boardIndex: i });
    }
    case 'attach':
      return act({ type: 'attach', cardIndex: Number(t.dataset.i) });
    case 'closeReveal':
      app.reveal = null;
      if (app.env) renderGame();
      return;
    case 'counter':
      return act({ type: 'counter' });
    case 'steal':
      return act({ type: 'steal', targetId: t.dataset.target, boardIndex: t.dataset.board !== undefined ? Number(t.dataset.board) : undefined });
    case 'freeRide':
      return act({ type: 'call', freeRide: true });
    case 'use': {
      const id = t.dataset.aug!;
      const payload: Record<string, unknown> = { type: 'useAugment', augment: id };
      if (app.targets[id]) payload.targetId = app.targets[id];
      if (t.dataset.i !== undefined) payload.cardIndex = Number(t.dataset.i);
      if (id === 'radar') payload.boardIndex = Number((($('[data-radar]') as HTMLSelectElement | null)?.value ?? app.radarIdx));
      if (id === 'rumor') payload.rumor = ($('[data-rumor]') as HTMLSelectElement | null)?.value ?? app.rumor;
      return act(payload);
    }
    case 'shepherdFake': {
      const sel = $('[data-fakecard]') as HTMLSelectElement | null;
      return act({ type: 'useAugment', augment: 'shepherd', card: sel?.value ?? app.fakeCard });
    }
    case 'dbgLevel': {
      const r = await send('debug:levelup');
      toast(r.ok ? '다음 핸드부터 블라인드가 한 단계 오르고 증강을 고릅니다.' : (r.error ?? '실패'));
      return;
    }
    case 'toggle':
      return act({ type: 'useAugment', augment: 'exemption', on: t.dataset.on === '1' });
    case 'disguise': {
      if (t.dataset.off) return act({ type: 'useAugment', augment: 'disguise', fakeId: null });
      const sel = $('[data-fake]') as HTMLSelectElement | null;
      return act({ type: 'useAugment', augment: 'disguise', fakeId: sel?.value ?? app.fake });
    }
    case 'dbgGive': {
      const raw = ($('#dbg-wild') as HTMLInputElement).value.trim();
      const wild = Number(raw);
      const parity = /^(even|짝)/.test(raw) ? 'even' : /^(odd|홀)/.test(raw) ? 'odd' : undefined;
      const r = await send('debug:give', {
        parity,
        playerId: ($('#dbg-player') as HTMLSelectElement).value,
        augment: ($('#dbg-aug') as HTMLSelectElement).value,
        wildRank: wild >= 2 && wild <= 14 ? wild : undefined,
      });
      toast(r.ok ? '증강을 지급했습니다.' : (r.error ?? '실패'));
      return;
    }
    case 'dbgChips': {
      const r = await send('debug:chips', {
        playerId: ($('#dbg-player') as HTMLSelectElement).value,
        chips: Number(($('#dbg-chips') as HTMLInputElement).value),
      });
      toast(r.ok ? '칩을 설정했습니다.' : (r.error ?? '실패'));
      return;
    }
    case 'dbgDeal': {
      const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
      const hands: Record<string, string[]> = {};
      document.querySelectorAll<HTMLInputElement>('[data-dbg-hand]').forEach((inp) => {
        if (inp.value.trim()) hands[inp.dataset.dbgHand!] = split(inp.value);
      });
      const board = split(($('#dbg-board') as HTMLInputElement).value);
      const burns = split(($('#dbg-burns') as HTMLInputElement).value);
      const deck = split(($('#dbg-deck') as HTMLInputElement).value);
      const r = await send('debug:deal', { board: board.length ? board : undefined, hands, burns, deck });
      toast(r.ok ? '다음 핸드에 적용됩니다.' : (r.error ?? '실패'));
      return;
    }
  }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target as HTMLFormElement;
  if (!form.hasAttribute('data-chat')) return;
  ev.preventDefault();
  const input = form.querySelector('input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  const r = await send('chat:send', { text });
  if (r.ok) input.value = '';
  else toast(r.error ?? '보내지 못했습니다.');
});

document.addEventListener('change', async (ev) => {
  const t = ev.target as HTMLElement;
  if (t.dataset.setting) {
    const key = t.dataset.setting;
    const raw = (t as HTMLInputElement | HTMLSelectElement).value;
    const value = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.dataset.kind === 'str' ? raw : Number(raw);
    const r = await send('room:settings', { [key]: value });
    if (!r.ok) {
      toast(r.error ?? '설정 실패');
      // 거부된 값은 서버 값으로 되돌린다
      if (app.screen === 'lobby' && app.lobby) {
        $('#lobby-main') && mount($('#lobby-main'), '');
        renderLobby();
      } else if (app.env) {
        mount($('#modal'), '');
        renderGame();
      }
    }
    return;
  }
  if ((t as HTMLInputElement).name === 'vis') {
    app.homePublic = (t as HTMLInputElement).value === 'public';
    return;
  }
  if (t.dataset.target) {
    app.targets[t.dataset.target] = (t as HTMLSelectElement).value;
    return;
  }
  if (t.hasAttribute('data-fake')) {
    app.fake = (t as HTMLSelectElement).value;
    return;
  }
  if (t.hasAttribute('data-radar')) {
    app.radarIdx = Number((t as HTMLSelectElement).value);
    return;
  }
  if (t.hasAttribute('data-rumor')) {
    app.rumor = (t as HTMLSelectElement).value;
    return;
  }
  if (t.hasAttribute('data-fakecard')) {
    app.fakeCard = (t as HTMLSelectElement).value;
    return;
  }
  if (t.dataset.dbg === 'reveal') {
    app.revealAll = (t as HTMLInputElement).checked;
    await send('debug:reveal', { on: app.revealAll });
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target as HTMLInputElement;
  const v = app.env?.view;
  if (!v) return;
  if (t.id === 'raise-range' || t.id === 'raise-num') {
    const val = Number(t.value);
    if (Number.isFinite(val)) {
      app.raise = val;
      const other = $(t.id === 'raise-range' ? '#raise-num' : '#raise-range') as HTMLInputElement | null;
      if (other) other.value = String(val);
      const l = v.you.legal;
      const lab = $('[data-raise-label]');
      if (lab && l) lab.textContent = fmt(val) + (val >= l.maxRaiseTo ? ' (올인)' : '');
    }
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const id = (ev.target as HTMLElement).id;
  if (id === 'home-code') homeEnter('join');
  else if (id === 'home-name') homeEnter(app.homeCode.trim() || ($('#home-code') as HTMLInputElement)?.value.trim() ? 'join' : 'create');
});

// ───────── 툴팁: 증강 이름에 마우스를 올리면 설명 (터치는 누르면 잠깐) ─────────

const tipEl = document.createElement('div');
tipEl.id = 'tip';
document.body.appendChild(tipEl);
let tipTimer: number | undefined;

function showTip(target: HTMLElement, x: number, y: number) {
  tipEl.textContent = target.dataset.tip ?? '';
  tipEl.className = 'show';
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 12))}px`;
  tipEl.style.top = `${Math.max(8, y + h + 20 > window.innerHeight ? y - h - 12 : y + 16)}px`;
}

document.addEventListener('mouseover', (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
  if (t) showTip(t, ev.clientX, ev.clientY);
  else tipEl.className = '';
});
document.addEventListener('mousemove', (ev) => {
  if (!tipEl.className) return;
  const t = (ev.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
  if (t) showTip(t, ev.clientX, ev.clientY);
});
document.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType !== 'touch') return;
  const t = (ev.target as HTMLElement).closest('[data-tip]') as HTMLElement | null;
  if (!t) return;
  showTip(t, ev.clientX, ev.clientY);
  clearTimeout(tipTimer);
  tipTimer = window.setTimeout(() => (tipEl.className = ''), 2500);
});

window.addEventListener('resize', () => {
  if (app.screen === 'game') renderGame();
});

// ───────── 시작 ─────────

{
  const params = new URLSearchParams(location.search);
  app.homeCode = (params.get('room') ?? '').toUpperCase().slice(0, 5);
  app.homeName = storageGet(localStorage, NAME_KEY) ?? '';
  // 이 탭에서 쓰던 자리가 있으면 연결되자마자 자동 복귀 (socket 'connect' 에서 처리)
  app.seat = readSeat(sessionStorage, SESSION_KEY);
  if (app.seat && app.homeCode && app.seat.code !== app.homeCode) app.seat = null;
  render();
  renderConn();
}
