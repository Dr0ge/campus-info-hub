import { config } from "./config";
import {
  isMessageProcessed,
  areMessagesProcessed,
  upsertSession,
  getEnabledSessions,
  insertRawMessage,
} from "./db";
import {
  normalizeRest,
  preFilterRest,
  type InternalMessage,
  type RestSession,
  type RestMessage,
} from "./normalize";

const API_BASE = config.weflow.baseUrl;
const TOKEN = config.weflow.token;

// ── HTTP Client ──

async function weflowGet<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WeFlow API error: ${res.status} on ${path} — ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Fetch Sessions ──

async function fetchSessions(): Promise<RestSession[]> {
  const data = await weflowGet<{ sessions: RestSession[] }>("/api/v1/sessions");
  return data.sessions || [];
}

// ── Fetch Messages ──
// Only date_from (no date_to) + retry — date_to makes WeFlow unreliable

async function fetchAllMessages(talker: string, dateFrom: string): Promise<RestMessage[]> {
  const qs = `talker=${talker}&date_from=${dateFrom}&limit=500`;

  let data = await weflowGet<{ success: boolean; messages: RestMessage[] }>(`/api/v1/messages?${qs}`);

  // Retry once if empty
  if (!data.messages || data.messages.length === 0) {
    await new Promise(r => setTimeout(r, 500));
    data = await weflowGet<{ success: boolean; messages: RestMessage[] }>(`/api/v1/messages?${qs}`);
  }

  return data.messages || [];
}

// ── Poll Result ──

export interface PollResult {
  messages: InternalMessage[];
  sessionCount: number;
  errors: string[];
}

// ── Main Poll Function ──

export async function poll(): Promise<PollResult> {
  const result: PollResult = { messages: [], sessionCount: 0, errors: [] };
  const now = new Date();
  const dateFrom = toDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const cutoff = Math.floor(now.getTime() / 1000) - 24 * 60 * 60; // Client-side safety filter

  console.log(`[poller] Fetching messages since ${dateFrom}, client cutoff ≤24h`);

  // Fetch contacts for wxid → display name mapping
  let contacts = new Map<string, string>();
  try {
    const contactsData = await weflowGet<{ contacts: { username: string; displayName: string }[] }>("/api/v1/contacts");
    for (const c of (contactsData.contacts || [])) {
      contacts.set(c.username, c.displayName || c.username);
    }
    console.log(`[poller] Loaded ${contacts.size} contacts`);
  } catch {
    // Contacts optional — sender names fall back to wxid
  }

  // Discover all sessions from WeFlow (upsert for discovery, keep existing enabled state)
  let allSessions: RestSession[];
  try {
    allSessions = await fetchSessions();
    for (const s of allSessions) {
      upsertSession(s.username, s.displayName, s.sessionType === "group");
    }
  } catch (err) {
    result.errors.push(`Failed to fetch sessions: ${err}`);
    return result;
  }

  // Only poll enabled sessions
  const enabledSessions = getEnabledSessions();
  result.sessionCount = enabledSessions.length;

  if (enabledSessions.length === 0) {
    console.log(`[poller] No enabled sessions. Discovered ${allSessions.length} sessions, enable groups in settings.`);
    return result;
  }

  console.log(`[poller] Polling ${enabledSessions.length} enabled sessions (${allSessions.length} total discovered)`);

  let totalRaw = 0;
  let totalSkipped = 0;
  let sessionIdx = 0;

  for (const session of enabledSessions) {
    sessionIdx++;
    try {
      const label = session.name || session.talker;
      const messages = await fetchAllMessages(session.talker, dateFrom);
      totalRaw += messages.length;

      if (messages.length === 0) {
        console.log(`  [${sessionIdx}/${enabledSessions.length}] ${label}: 无新消息`);
        continue;
      }

      // Batch-check processed messages (avoid N+1 per-message queries)
      const msgIds = messages.map(m => `rest:${m.serverId}`);
      const processedSet = areMessagesProcessed(msgIds);

      let sessionNew = 0;
      let sessionSkipped = 0;
      let sessionOld = 0;
      for (const msg of messages) {
        if (msg.createTime < cutoff) { sessionOld++; continue; }
        if (!preFilterRest(msg)) { sessionSkipped++; totalSkipped++; continue; }

        const msgId = `rest:${msg.serverId}`;
        if (processedSet.has(msgId)) continue;

        const groupName = session.name || session.talker;
        const normalized = normalizeRest(msg, session.talker, groupName, contacts);
        result.messages.push(normalized);
        // Store raw message for local context lookup
        insertRawMessage(normalized.msgId, normalized.sessionId, normalized.groupName,
          normalized.senderName, normalized.content, normalized.timestamp);
        sessionNew++;
      }

      if (sessionNew > 0 || sessionSkipped > 0 || sessionOld > 0) {
        console.log(`  [${sessionIdx}/${enabledSessions.length}] ${label}: ${messages.length} 条 → ${sessionNew} 新, ${sessionSkipped} 过滤, ${sessionOld} 超24h`);
      }
    } catch (err) {
      console.error(`  [${sessionIdx}/${enabledSessions.length}] ${session.name || session.talker}: 失败 — ${err}`);
      result.errors.push(`Failed: ${session.talker}: ${err}`);
    }
  }

  console.log(`[poller] 完成: ${result.messages.length} 条新消息 (原始 ${totalRaw}, 预过滤 ${totalSkipped}, 涉及 ${enabledSessions.length} 个群聊)`);
  return result;
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

