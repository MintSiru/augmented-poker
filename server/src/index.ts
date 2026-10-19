// HTTP + Socket.IO 서버. 클라이언트 정적 파일도 같은 주소로 제공한다.

import express from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import {
  debugGiveAugment,
  debugSetNextDeal,
  debugSetChips,
  debugLevelUp,
  getDebugView,
  isAugmentId,
  type GameAction,
} from '../../engine/src/index.js';
import { CODE_RE, DEFAULT_OPTIONS, LIST_ROOM, RoomManager, sanitizeName, type Member, type Room, type ServerOptions } from './rooms.js';

export interface AppServer {
  httpServer: HttpServer;
  io: Server;
  rooms: RoomManager;
  port: number;
  close(): Promise<void>;
}

type AckFn = (res: unknown) => void;

function findPublicDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PUBLIC_DIR,
    path.resolve(here, '../../public'), // dist/server/src → dist/public
    path.resolve(here, '../../dist/public'), // server/src (tsx 실행) → dist/public
  ].filter((x): x is string => !!x);
  return candidates.find((d) => existsSync(path.join(d, 'index.html'))) ?? null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function createAppServer(port = 0, overrides: Partial<ServerOptions> = {}): Promise<AppServer> {
  const opts: ServerOptions = { ...DEFAULT_OPTIONS, ...overrides };
  const app = express();
  app.disable('x-powered-by');
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 64 * 1024 });
  const rooms = new RoomManager(io, opts);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.rooms.size, uptime: Math.round(process.uptime()) });
  });
  const publicDir = findPublicDir();
  if (publicDir) {
    app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, p) => {
      if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    } }));
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send('클라이언트 빌드가 없습니다. npm run build 후 다시 실행하거나, 개발 중이면 npm run dev 의 Vite 주소(5173)로 접속하세요.');
    });
  }

  io.on('connection', (socket: Socket) => {
    // 이 소켓이 연결된 방/플레이어 (재접속 시 토큰으로 다시 연결)
    let current: { room: Room; member: Member } | null = null;

    const bind = (room: Room, member: Member) => {
      // 같은 자리에 다른 창이 붙어 있으면 그 창을 끊는다
      if (member.socketId && member.socketId !== socket.id) {
        const old = io.sockets.sockets.get(member.socketId);
        old?.emit('kicked', '다른 창에서 같은 자리로 접속했습니다.');
        old?.disconnect(true);
      }
      if (current && current.member !== member) current.room.detach(current.member);
      current = { room, member };
      room.attach(member, socket.id);
      socket.emit('chat:history', room.chat);
      room.sync();
    };

    const reply = (ack: unknown, res: unknown) => {
      if (typeof ack === 'function') (ack as AckFn)(res);
    };

    // 공개 방 목록: 구독한 소켓에만 실시간으로 보낸다 (방 이름·인원·상태·설정값만)
    socket.on('rooms:watch', (payload: unknown, ack: unknown) => {
      const on = !isObj(payload) || payload.on !== false;
      if (on) {
        socket.join(LIST_ROOM);
        socket.emit('rooms', rooms.publicList());
      } else socket.leave(LIST_ROOM);
      reply(ack, { ok: true });
    });

    socket.on('room:create', (payload: unknown, ack: unknown) => {
      const name = sanitizeName(isObj(payload) ? payload.name : null);
      if (!name) return reply(ack, { ok: false, error: '닉네임을 입력하세요 (12자 이내).' });
      const isPublic = !(isObj(payload) && payload.isPublic === false);
      const r = rooms.createRoom(name, isObj(payload) ? payload.roomName : null, isPublic);
      if (typeof r === 'string') return reply(ack, { ok: false, error: r });
      const { room, member } = r;
      socket.leave(LIST_ROOM);
      bind(room, member);
      reply(ack, { ok: true, code: room.code, token: member.token, playerId: member.id });
    });

    socket.on('room:join', (payload: unknown, ack: unknown) => {
      if (!isObj(payload)) return reply(ack, { ok: false, error: '잘못된 요청입니다.' });
      const name = sanitizeName(payload.name);
      const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
      if (!name) return reply(ack, { ok: false, error: '닉네임을 입력하세요 (12자 이내).' });
      if (!CODE_RE.test(code)) return reply(ack, { ok: false, error: '방 코드는 영문 대문자+숫자 5자리입니다.' });
      const r = rooms.join(code, name, payload.prevToken);
      if (typeof r === 'string') return reply(ack, { ok: false, error: r });
      socket.leave(LIST_ROOM);
      bind(r.room, r.member);
      reply(ack, { ok: true, code: r.room.code, token: r.member.token, playerId: r.member.id });
    });

    socket.on('room:resume', (payload: unknown, ack: unknown) => {
      const token = isObj(payload) ? payload.token : null;
      if (rooms.isRevoked(token)) return reply(ack, { ok: false, error: '추방되어 그 방에 다시 들어갈 수 없습니다.' });
      const found = rooms.byToken(token);
      if (!found || found.member.left) return reply(ack, { ok: false, error: '이전 자리를 찾을 수 없습니다.' });
      bind(found.room, found.member);
      reply(ack, { ok: true, code: found.room.code, token: found.member.token, playerId: found.member.id });
    });

    socket.on('room:leave', (_payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: true });
      const { room, member } = current;
      current = null;
      room.leave(member);
      rooms.forgetToken(member.token);
      room.sync();
      reply(ack, { ok: true });
    });

    socket.on('room:settings', (payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      if (!isObj(payload)) return reply(ack, { ok: false, error: '잘못된 요청입니다.' });
      const err = current.room.updateSettings(current.member, payload);
      current.room.sync();
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    socket.on('room:kick', (payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      const err = current.room.kick(current.member, isObj(payload) ? payload.playerId : null);
      current.room.sync();
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    socket.on('room:start', (_payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      const err = current.room.start(current.member);
      current.room.sync();
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    socket.on('room:lobby', (_payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      const err = current.room.backToLobby(current.member);
      current.room.sync();
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    socket.on('chat:send', (payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      const err = current.room.sendChat(current.member, isObj(payload) ? payload.text : null);
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    // 모든 게임 행동은 서버(엔진)에서 검증한다: 차례, 금액, 증강 보유/남은 횟수 등
    socket.on('game:action', (payload: unknown, ack: unknown) => {
      if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
      if (!isObj(payload) || typeof payload.type !== 'string') return reply(ack, { ok: false, error: '잘못된 요청입니다.' });
      const err = current.room.act(current.member, payload as unknown as GameAction);
      current.room.sync();
      reply(ack, err ? { ok: false, error: err } : { ok: true });
    });

    // ── 디버그 기능: DEBUG=true 로 실행했을 때만 이벤트 자체를 등록한다 ──
    if (opts.debug) {
      socket.on('debug:reveal', (payload: unknown, ack: unknown) => {
        if (!current) return reply(ack, { ok: false, error: '방에 들어가 있지 않습니다.' });
        const on = isObj(payload) && payload.on === true;
        if (on) current.room.debugReveal.add(current.member.id);
        else current.room.debugReveal.delete(current.member.id);
        socket.emit('debug:state', on && current.room.game ? getDebugView(current.room.game) : null);
        reply(ack, { ok: true });
      });
      socket.on('debug:give', (payload: unknown, ack: unknown) => {
        const g = current?.room.game;
        if (!current || !g || !isObj(payload)) return reply(ack, { ok: false, error: '게임 중이 아닙니다.' });
        if (typeof payload.playerId !== 'string' || !isAugmentId(payload.augment)) {
          return reply(ack, { ok: false, error: '대상과 증강을 고르세요.' });
        }
        const wild = typeof payload.wildRank === 'number' ? payload.wildRank : undefined;
        const parity = payload.parity === 'even' || payload.parity === 'odd' ? payload.parity : undefined;
        const r = debugGiveAugment(g, payload.playerId, payload.augment, wild, parity);
        current.room.sync();
        reply(ack, r);
      });
      socket.on('debug:deal', (payload: unknown, ack: unknown) => {
        const g = current?.room.game;
        if (!current || !g || !isObj(payload)) return reply(ack, { ok: false, error: '게임 중이 아닙니다.' });
        const board = Array.isArray(payload.board) ? payload.board.map(String) : undefined;
        const hands: Record<string, string[]> = {};
        if (isObj(payload.hands)) {
          for (const [id, cards] of Object.entries(payload.hands)) if (Array.isArray(cards)) hands[id] = cards.map(String);
        }
        const list = (v: unknown) => (Array.isArray(v) && v.length ? v.map(String) : undefined);
        const r = debugSetNextDeal(g, { board, hands, burns: list(payload.burns), deck: list(payload.deck) });
        current.room.sync();
        reply(ack, r);
      });
      socket.on('debug:levelup', (_payload: unknown, ack: unknown) => {
        const g = current?.room.game;
        if (!current || !g) return reply(ack, { ok: false, error: '게임 중이 아닙니다.' });
        const r = debugLevelUp(g);
        current.room.sync();
        reply(ack, r);
      });
      // 특정 플레이어의 연결을 끊은 상태로 만들기 (그 창은 '다시 연결'을 누를 때까지 끊긴 채로 둔다)
      socket.on('debug:disconnect', (payload: unknown, ack: unknown) => {
        if (!current || !current.room.game || !isObj(payload)) return reply(ack, { ok: false, error: '게임 중이 아닙니다.' });
        const room = current.room;
        const m = typeof payload.playerId === 'string' ? room.member(payload.playerId) : undefined;
        if (!m || m.isBot) return reply(ack, { ok: false, error: '사람 플레이어를 고르세요.' });
        if (!m.connected) return reply(ack, { ok: false, error: '이미 연결이 끊겨 있습니다.' });
        const sock = m.socketId ? io.sockets.sockets.get(m.socketId) : undefined;
        reply(ack, { ok: true });
        if (sock) sock.disconnect(true);
        else {
          room.detach(m);
          room.sync();
        }
      });
      socket.on('debug:chips', (payload: unknown, ack: unknown) => {
        const g = current?.room.game;
        if (!current || !g || !isObj(payload)) return reply(ack, { ok: false, error: '게임 중이 아닙니다.' });
        const r = debugSetChips(g, String(payload.playerId), Number(payload.chips));
        current.room.sync();
        reply(ack, r);
      });
    }

    socket.on('disconnect', () => {
      if (!current) return;
      const { room, member } = current;
      current = null;
      if (member.socketId === socket.id) {
        room.detach(member);
        room.sync();
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    httpServer,
    io,
    rooms,
    port: actualPort,
    close: async () => {
      rooms.shutdown();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  // 디버그 모드는 DEBUG=true 일 때만. 배포 환경(Render)에서는 설정하지 않으므로 서버 코드에서 완전히 꺼진다.
  const debug = process.env.DEBUG === 'true';
  createAppServer(port, { debug }).then((s) => {
    console.log(`증강 홀덤 서버 실행 중: http://localhost:${s.port}${debug ? '  [DEBUG 모드]' : ''}`);
  });
}
