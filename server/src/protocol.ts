// 서버 ↔ 클라이언트 메시지 형식. 클라이언트는 이 파일의 타입만 가져다 쓴다(런타임 코드 없음).

import type { PlayerView, DebugView, PendingKind } from '../../engine/src/index.js';

export interface RoomSettings {
  maxPlayers: number;
  fillBots: boolean;
  botCount: number;
  turnSeconds: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  connected: boolean;
  isHost: boolean;
}

export interface LobbyState {
  code: string;
  youId: string;
  hostId: string;
  settings: RoomSettings;
  players: LobbyPlayer[];
  debug: boolean;
}

export interface GameEnvelope {
  code: string;
  view: PlayerView;
  /** 현재 결정의 마감 시각 (서버 시계, ms) */
  deadline: number | null;
  deadlineKind: PendingKind | null;
  serverNow: number;
  youAreHost: boolean;
  debug: boolean;
}

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface JoinResult {
  code: string;
  token: string;
  playerId: string;
}

/** 채팅 메시지 (방 안의 모두에게 공개되는 정보) */
export interface ChatMessage {
  id: number;
  fromId: string;
  name: string;
  text: string;
  ts: number;
}

export interface ServerToClient {
  lobby: (s: LobbyState) => void;
  game: (s: GameEnvelope) => void;
  'debug:state': (s: DebugView | null) => void;
  kicked: (reason: string) => void;
  chat: (m: ChatMessage) => void;
  'chat:history': (list: ChatMessage[]) => void;
}

export type { PlayerView, DebugView };
