// 클라이언트: 서버가 보내 준 "내 화면 정보"(PlayerView)만으로 화면을 그린다.
// 게임 규칙 판단은 하지 않으며, 모든 행동은 서버로 보내 검증받는다.

import { io, type Socket } from 'socket.io-client';
import './style.css';
import type { ChatMessage, DebugView, GameEnvelope, LobbyState } from '../../server/src/protocol.js';
import type { MyAugmentView, PlayerView, PublicPlayerView } from '../../engine/src/view.js';
import { AUGMENTS, type AugmentId } from '../../engine/src/augments.js';
import { $, cardBack, cardHtml, esc, fmt, mount, patch, richText, stars } from './dom.js';
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
});
socket.on('disconnect', () => {
  app.connected = false;
  renderConn();
});
socket.on('lobby', (s: LobbyState) => {
  app.lobby = s;
  app.env = null;
  app.debug = null;
  app.screen = 'lobby';
  render();
});
socket.on('game', (e: GameEnvelope) => {
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
  app.seat = null;
  app.screen = 'home';
  app.homeError = reason;
  render();
});

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
  el.textContent = show ? '서버와 연결이 끊겼습니다. 재연결 중…' : '';
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
  if (app.screen === 'home') renderHome();
  else if (app.screen === 'lobby') renderLobby();
  else renderGame();
}

// ───────── 첫 화면 ─────────

function syncHomeInputs() {
  const n = $('#home-name') as HTMLInputElement | null;
  const c = $('#home-code') as HTMLInputElement | null;
  if (n) app.homeName = n.value;
  if (c) app.homeCode = c.value;
}

function renderHome() {
  $('#modal')!.innerHTML = '';
  const last = readSeat(localStorage, LAST_KEY);
  patch(
    $('#app'),
    `<div class="home">
      <h1><span class="logo">♠</span> 증강 홀덤</h1>
      <p class="sub">텍사스 홀덤 + 증강 · 최대 8명</p>
      <label class="field">닉네임<input id="home-name" maxlength="12" autocomplete="nickname" value="${esc(app.homeName)}" placeholder="12자 이내" /></label>
      <button class="primary big" data-a="create">방 만들기</button>
      <div class="or">또는</div>
      <div class="join-row">
        <input id="home-code" maxlength="5" placeholder="방 코드 5자리" value="${esc(app.homeCode)}" autocapitalize="characters" />
        <button class="big" data-a="join">방 코드로 입장</button>
      </div>
      ${last ? `<button class="ghost" data-a="resumeLast">이전 방(${esc(last.code)})의 내 자리로 돌아가기</button>` : ''}
      <p class="err">${esc(app.homeError)}</p>
    </div>`,
  );
}

async function homeEnter(kind: 'create' | 'join') {
  syncHomeInputs();
  const name = app.homeName.trim();
  if (!name) {
    app.homeError = '닉네임을 입력하세요.';
    return renderHome();
  }
  storageSet(localStorage, NAME_KEY, name);
  const r =
    kind === 'create'
      ? await send('room:create', { name })
      : await send('room:join', { name, code: app.homeCode.trim().toUpperCase() });
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
      return `<div class="cm ${m.fromId === me ? 'mine' : ''}"><span class="cm-name">${esc(m.name)}</span><span class="cm-text">${esc(m.text)}</span><span class="cm-time">${hhmm}</span></div>`;
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
  const l = app.lobby!;
  const isHost = l.youId === l.hostId;
  const s = l.settings;
  const humans = l.players.length;
  const bots = s.fillBots ? Math.min(s.botCount, s.maxPlayers - humans) : 0;
  const opt = (from: number, to: number, cur: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`)
      .join('');
  const settings = isHost
    ? `<label>최대 인원 <select data-setting="maxPlayers">${opt(Math.max(2, humans), 8, s.maxPlayers)}</select></label>
       <label class="check"><input type="checkbox" data-setting="fillBots" ${s.fillBots ? 'checked' : ''}/> 빈자리를 봇으로 채우기</label>
       <label>봇 수 <select data-setting="botCount" ${s.fillBots ? '' : 'disabled'}>${opt(0, Math.max(0, s.maxPlayers - humans), Math.min(s.botCount, s.maxPlayers - humans))}</select></label>
       <label>행동 제한 시간 <select data-setting="turnSeconds">${[10, 15, 20, 30, 45, 60, 90]
         .map((v) => `<option value="${v}" ${v === s.turnSeconds ? 'selected' : ''}>${v}초</option>`)
         .join('')}</select></label>`
    : `<p>최대 ${s.maxPlayers}명 · 봇 ${s.fillBots ? `${bots}명` : '없음'} · 제한 시간 ${s.turnSeconds}초</p><p class="muted">방장이 설정하고 시작합니다.</p>`;
  patch(
    $('#lobby-main'),
    `<div class="lobby">
      <div class="lobby-head">
        <div>방 코드 <b class="code">${esc(l.code)}</b></div>
        <button data-a="copy">링크 복사</button>
      </div>
      <div class="panel">
        <h3>참가자 ${humans}/${s.maxPlayers}${bots ? ` <span class="muted">+ 봇 ${bots}</span>` : ''}</h3>
        <ul class="plist">
          ${l.players
            .map(
              (p) =>
                `<li class="${p.connected ? '' : 'off'}">${p.isHost ? '<span class="crown">👑</span>' : ''}${esc(p.name)}${p.id === l.youId ? ' <span class="muted">(나)</span>' : ''}${p.connected ? '' : ' <span class="muted">연결 끊김</span>'}</li>`,
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
        ${isHost ? `<button class="primary big" data-a="start" ${humans + bots >= 2 ? '' : 'disabled'}>게임 시작</button>` : ''}
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
      <span class="muted hide-sm">상승까지 ${Math.max(0, v.handsUntilLevelUp)}핸드</span>
      ${v.table.taxers.length ? `<span class="taxbadge" title="죽음과 세금 선언자: ${esc(v.table.taxers.join(', '))}">💀 세금 ${v.you.tax ? `${fmt(v.you.tax)}칩/사용` : '면제'}</span>` : ''}</div>
     <div class="tb-right"><span class="wait">${waitingText(v)} <span class="timer-text" data-timer></span></span>
      ${env.debug ? '<span class="debug-flag">DEBUG</span>' : ''}
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
  const cls = ['seat', me ? 'mine' : '', p.isTurn ? 'turn' : '', p.folded ? 'folded' : '', p.out ? 'out' : '', p.connected ? '' : 'off']
    .filter(Boolean)
    .join(' ');
  const badges = [p.isDealer ? '<i class="b d">D</i>' : '', p.isSB ? '<i class="b">SB</i>' : '', p.isBB ? '<i class="b">BB</i>' : '']
    .join('');
  let cards = '';
  if (p.shownCards) cards = p.shownCards.map((c) => cardHtml(c, { size: 'sm', extra: me ? handCardClass(v, c) : '' })).join('');
  else if (me && v.you.hole.length && !p.folded) cards = v.you.hole.map((c) => cardHtml(c, { size: 'sm', extra: handCardClass(v, c) })).join('');
  else if (p.hasCards) cards = cardBack('sm') + cardBack('sm');
  const status = p.out
    ? `탈락${p.place ? ` (${p.place}위)` : ''}`
    : p.sittingOut
      ? '자리 비움'
      : !p.connected
        ? '연결 끊김'
        : p.allIn
          ? '올인'
          : (p.lastAction ?? '');
  const revealed = p.revealedAugments
    .map((a) => `<span class="pub s${a.stars}" title="${esc(a.description)}">${esc(a.name)}${stars(a.stars)}</span>`)
    .join('');
  const shep = p.shepherdShown.length
    ? `<div class="seat-shep" title="양치기 소년으로 공개한 카드 (진짜인지 알 수 없음)">공개 ${p.shepherdShown.map((c) => cardHtml(c, { size: 'sm', extra: 'inline' })).join('')}</div>`
    : '';
  const bubble = app.bubbles.get(p.id);
  // 화면 위쪽 좌석은 말풍선을 아래로 (상단 바를 가리지 않도록)
  const bubbleHtml = bubble && bubble.until > Date.now() ? `<div class="bubble${y < 30 ? ' below' : ''}">${esc(bubble.text)}</div>` : '';
  const bx = 50 + (x - 50) * 0.62;
  const by = 50 + (y - 50) * 0.55;
  return `<div class="${cls}" style="left:${x}%;top:${y}%">${bubbleHtml}
      <div class="seat-top"><span class="nm">${p.isBot ? '🤖 ' : ''}${esc(p.name)}</span>${badges}</div>
      <div class="seat-mid"><span class="chips">${fmt(p.chips)}</span><span class="cards">${cards}</span></div>
      <div class="seat-status">${esc(status)}${!p.connected && !p.out ? ' ⚠' : ''}</div>
      ${shep}
      <div class="seat-augs"><span class="cnt" title="보유 증강 수">증강 ${p.augmentCount}</span>${revealed}</div>
    </div>
    ${p.streetBet > 0 ? `<div class="bet" style="left:${bx}%;top:${by}%">${fmt(p.streetBet)}</div>` : ''}`;
}

function reactionHtml(v: PlayerView): string {
  const r = v.reaction;
  if (!r) return '';
  const who = r.mine ? '내' : `${esc(r.declarerName)}님의`;
  const what = r.anonymous && !r.mine ? '비공개 증강' : `「${esc(r.label)}」`;
  return `<div class="reaction ${r.countered ? 'countered' : ''}">
      <div>${who} ${what} 선언 <span class="timer-text" data-timer></span></div>
      ${r.countered ? `<div class="rx-sub">🛡 ${esc(r.counteredBy ?? '')}의 카운터 스펠로 무효화됨</div>` : '<div class="rx-sub">반응 대기 중…</div>'}
      ${r.canCounter && !r.countered ? `<button class="primary small" data-a="counter">카운터 스펠: 무효화할까요?${v.you.tax ? ` (세금 ${fmt(v.you.tax)})` : ''}</button>` : ''}
      ${r.queued ? `<div class="rx-sub">대기 중인 선언 ${r.queued}개</div>` : ''}
    </div>`;
}

function renderTable(v: PlayerView) {
  const n = v.players.length;
  const mySeat = v.players.findIndex((p) => p.id === v.you.id);
  const seats = v.players.map((p, i) => seatHtml(v, p, (i - mySeat + n) % n, n)).join('');
  patch($('#g-seats'), seats);

  const slots = Array.from({ length: 5 }, (_, i) => {
    if (i >= v.board.length) return '<span class="card slot md"></span>';
    const c = v.board[i];
    if (!c) return `<span class="card back md fog" title="짙은 안개: 쇼다운 때 공개"></span>`;
    // 봉인된 카드는 족보 계산에서 빠지므로 강조하지 않는다
    const sealed = v.sealed.includes(i);
    return cardHtml(c, { size: 'md', extra: sealed ? 'sealed' : handCardClass(v, c) });
  }).join('');
  const notes = v.table.notes.map((t) => `<span class="tnote">${esc(t)}</span>`).join('');
  patch(
    $('#g-center'),
    `${notes ? `<div class="tnotes">${notes}</div>` : ''}
     <div class="board">${slots}</div>
     <div class="pot">팟 ${fmt(v.pot)}</div>
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
            ...e.tiebreak.map((t) => `<em class="tb">${esc(t)}로 승리</em>`),
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
  const me = v.players.find((p) => p.id === v.you.id)!;
  let html: string;
  if (v.you.out) {
    html = `<div class="hand-info">탈락했습니다${me.place ? ` (${me.place}위)` : ''}. 게임은 계속 볼 수 있습니다.</div>`;
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
  const html = `<div class="timerbar"><div class="fill" data-timerbar></div></div>
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
      return `<span class="muted" title="${esc(a.hint)}">${a.usesLeft ? '다른 사람 증강의 반응 대기 중에 버튼이 나타남' : '사용함'}</span>`;
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
  };
  return useBtn(v, a, labels[a.id] ?? '사용');
}

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
          const kind = a.public ? '<span class="tag pubkind">공개형</span>' : a.disclosure === 'anonymous' ? '<span class="tag">익명 알림</span>' : '';
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
  patch($('#g-augs'), html);
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
  const kindName: Record<string, string> = { burn: '번', fold: '폴드', discard: '버림', rewind: '되감기' };
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
  const noteHtml = notes.length
    ? `<div class="notes"><h4>나만 아는 정보</h4>${notes
        .slice(-8)
        .map((n) => `<div class="note ${n.kind}">${richText(n.text)}${n.hand !== v.handNumber ? ` <span class="muted">(#${n.hand})</span>` : ''}</div>`)
        .join('')}</div>`
    : '';
  patch($('#g-notes'), noteHtml + countingHtml(v));
}

function renderLog(v: PlayerView) {
  const el = $('#g-log')!;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const html = v.log.map((e) => `<div class="le${e.text.startsWith('──') ? ' sep' : ''}">${richText(e.text)}</div>`).join('');
  if (patch(el, html) && (nearBottom || app.lastLogSeq === 0)) el.scrollTop = el.scrollHeight;
  app.lastLogSeq = v.log.at(-1)?.seq ?? 0;
}

function renderModal(env: GameEnvelope, v: PlayerView) {
  const el = $('#modal');
  const you = v.you;
  let html = '';
  if (you.pick && you.pick.length) {
    html = `<div class="modal-bg"><div class="modal pick">
      <h3>증강 선택 <span class="timer-text" data-timer></span></h3>
      <p class="muted">레벨 ${v.level} · 하나를 고르세요. 시간이 지나면 무작위로 선택됩니다.</p>
      <div class="pick-row">${you.pick
        .map(
          (a) => `<button class="pick-card s${a.stars}" data-a="pick" data-aug="${a.id}">
          <div class="big-stars">${stars(a.stars)}</div>
          <div class="pc-name">${esc(a.name)}</div>
          <div class="pc-cat">${esc(a.category)}</div>
          <div class="pc-desc">${esc(a.description)}</div></button>`,
        )
        .join('')}</div></div></div>`;
  } else if (v.reaction) {
    html = '';
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
    const tax = you.tax ? ` <span class="taxtag">세금 ${fmt(you.tax)}</span>` : '';
    html = `<div class="modal-bg"><div class="modal">
      <h3>선언 기회 (${v.street === 'turn' ? '턴' : '리버'} 공개 직후) <span class="timer-text" data-timer></span></h3>
      <p class="muted">내 카드 ${you.hole.length ? you.hole.map((c) => cardHtml(c, { size: 'sm', extra: 'inline' })).join('') : '(암전)'} · 선언하면 3초 반응 대기 후 적용됩니다.</p>
      ${opts
        .filter((o) => o.id !== 'seal')
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
      <button data-a="declare" data-aug="">선언하지 않음</button></div></div>`;
  } else if (you.attach) {
    html = `<div class="modal-bg"><div class="modal">
      <h3>애착: 다음 핸드로 가져갈 카드 <span class="timer-text" data-timer></span></h3>
      <p class="muted">고르지 않으면 높은 카드를 가져갑니다.</p>
      <div class="choose-row">${you.attach.cards
        .map((c, i) => `<button class="card-btn" data-a="attach" data-i="${i}">${cardHtml(c, { size: 'lg' })}<span>가져가기</span></button>`)
        .join('')}</div></div></div>`;
  } else if (v.phase === 'gameOver') {
    const ranking = [...v.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    html = `<div class="modal-bg"><div class="modal">
      <h3>🏆 ${esc(nameOf(v, v.winnerId))} 우승!</h3>
      <ol class="ranking">${ranking.map((p) => `<li>${esc(p.name)} <span class="muted">${p.place ?? '-'}위</span></li>`).join('')}</ol>
      <div class="lobby-actions">${env.youAreHost ? '<button class="primary" data-a="toLobby">같은 멤버로 대기실로</button>' : '<span class="muted">방장이 대기실로 돌아갈 수 있습니다.</span>'}
      <button data-a="leave">나가기</button></div></div></div>`;
  } else if (v.phase === 'augmentSelect' && you.pickDone && !you.out) {
    html = `<div class="banner">다른 플레이어가 증강을 고르는 중… <span class="timer-text" data-timer></span></div>`;
  }
  patch(el, html);
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
                `${esc(a.name)}${a.wildRank ? `(${esc(a.wildRank)})` : ''}${a.usesLeft !== null ? `[${a.usesLeft}]` : ''}${a.revealed ? `✓${a.publicName !== a.name ? `→${esc(a.publicName)}` : ''}` : ''}${a.armed ? '⚡' : ''}${a.fakeId ? `(위장:${esc(AUGMENTS[a.fakeId].name)})` : ''}`,
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
      <input id="dbg-wild" placeholder="편애 숫자 2~14" size="6" />
      <button class="small" data-a="dbgGive">증강 지급</button></div>
    <div class="dbg-row"><input id="dbg-chips" placeholder="칩" size="6" /><button class="small" data-a="dbgChips">칩 설정</button>
      <button class="small" data-a="dbgLevel">블라인드 레벨 즉시 올리기</button></div>
    <div class="dbg-deal">
      <div class="muted">다음 핸드 카드 지정 (예: As Kd 7c)</div>
      <label>보드 <input id="dbg-board" placeholder="최대 5장" /></label>
      ${v.players.filter((p) => !p.out).map((p) => `<label>${esc(p.name)} <input data-dbg-hand="${esc(p.id)}" placeholder="2~3장" /></label>`).join('')}
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
  const ms = remainingMs();
  const text = ms === null ? '' : `${Math.ceil(ms / 1000)}초`;
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
      return act({ type: 'pick', augment: t.dataset.aug });
    case 'discard':
      return act({ type: 'discard', cardIndex: Number(t.dataset.i) });
    case 'declare': {
      const aug = t.dataset.aug || null;
      const i = t.dataset.i !== undefined ? Number(t.dataset.i) : undefined;
      return act({ type: 'declare', augment: aug, boardIndex: i });
    }
    case 'attach':
      return act({ type: 'attach', cardIndex: Number(t.dataset.i) });
    case 'counter':
      return act({ type: 'counter' });
    case 'freeRide':
      return act({ type: 'call', freeRide: true });
    case 'use': {
      const id = t.dataset.aug!;
      const payload: Record<string, unknown> = { type: 'useAugment', augment: id };
      if (app.targets[id]) payload.targetId = app.targets[id];
      if (t.dataset.i !== undefined) payload.cardIndex = Number(t.dataset.i);
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
      const wild = Number(($('#dbg-wild') as HTMLInputElement).value);
      const r = await send('debug:give', {
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
      const r = await send('debug:deal', { board: board.length ? board : undefined, hands });
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
    const value = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : Number((t as HTMLSelectElement).value);
    const r = await send('room:settings', { [key]: value });
    if (!r.ok) toast(r.error ?? '설정 실패');
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
