// ── Internal Message Interface ──

export interface InternalMessage {
  msgId: string;
  content: string;
  senderName: string;
  senderId: string;
  sessionId: string;
  groupName: string;
  timestamp: number;
}

// ── SSE Raw Event ──

export interface SseMessageEvent {
  event: string;
  sessionId: string;
  sessionType: string;
  rawid: string;
  avatarUrl: string;
  groupName?: string;
  sourceName: string;
  content: string;
  timestamp: number;
}

// ── REST Raw Message ──

export interface RestMessage {
  localId: number;
  serverId: string;
  localType: number;
  createTime: number;
  sortSeq: number;
  isSend: number;
  senderUsername: string | null;
  content: string;
  rawContent: string;
  parsedContent: string;
}

// ── REST Session ──

export interface RestSession {
  username: string;
  displayName: string;
  type: number;
  sessionType: string;
  lastTimestamp: number;
  unreadCount: number;
}

// ── Normalize SSE → InternalMessage ──

export function normalizeSse(event: SseMessageEvent): InternalMessage {
  const isGroup = event.sessionType === "group";
  return {
    msgId: `sse:${event.rawid}`,
    content: event.content,
    senderName: event.sourceName || "未知",
    senderId: "",
    sessionId: event.sessionId,
    groupName: isGroup ? (event.groupName || event.sessionId) : event.sourceName,
    timestamp: event.timestamp,
  };
}

export function preFilterSse(event: SseMessageEvent): boolean {
  if (event.event === "message.revoke") return false;
  if (event.event !== "message.new") return false;
  const c = event.content;
  if (!c || c === "[消息]" || c.trim().length < 5) return false;
  return true;
}

// ── Normalize REST → InternalMessage ──

export function normalizeRest(
  msg: RestMessage,
  sessionId: string,
  groupName: string,
  contacts?: Map<string, string>
): InternalMessage {
  const wxid = msg.senderUsername || "";
  const displayName = contacts?.get(wxid) || wxid || "未知";
  return {
    msgId: `rest:${msg.serverId}`,
    content: msg.content,
    senderName: displayName,
    senderId: wxid,
    sessionId,
    groupName,
    timestamp: msg.createTime,
  };
}

// ── Pre-Filter ──

export function preFilterRest(msg: RestMessage): boolean {
  // Only text messages (localType === 1)
  if (msg.localType !== 1) return false;
  // Reject empty or placeholder
  const content = msg.content;
  if (!content || content === "[消息]" || content.trim() === "" || content.trim().length < 5) {
    return false;
  }
  return true;
}

