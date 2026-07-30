import { serve } from "bun";
import { config } from "./config";
import { getItems, getCategoryCounts, getAllCategoryCount, getIgnoredCount, getUsefulCount, updateItemVerify, getAllSessions, toggleSession, getLatestDigest, getContextMessages, getContactName } from "./db";

const server = serve({
  port: config.server.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // API routes
    if (path === "/api/items" && req.method === "GET") {
      const category = url.searchParams.get("category");
      const verified = (url.searchParams.get("verified") || "unverified") as "all" | "unverified" | "useful" | "ignored";

      const items = getItems({ category: category || undefined, verified });
      const categories = getCategoryCounts();
      const allCount = getAllCategoryCount();
      const ignoredCount = getIgnoredCount();

      // Compute relative times
      const now = Date.now();
      const itemsWithRelative = items.map((item) => ({
        ...item,
        relativeTime: relativeTimeStr(
          (item.msg_time || new Date(item.created_at).getTime() / 1000) * 1000,
          now
        ),
      }));

      return Response.json({
        items: itemsWithRelative,
        categories: [
          { key: "全部", count: allCount },
          ...categories,
        ],
        usefulCount: getUsefulCount(),
        ignoredCount,
        status: getStatus(),
      });
    }

    if (path.startsWith("/api/items/") && path.endsWith("/verify") && req.method === "POST") {
      const parts = path.split("/");
      const id = parts.length >= 4 ? decodeURIComponent(parts[3]) : "";
      if (!id || id === "verify") return Response.json({ success: false }, { status: 400 });
      const body = await req.json();
      const verified = body.verified;
      if (verified !== 1 && verified !== -1 && verified !== 0) {
        return Response.json({ success: false, message: "verified must be 0, 1, or -1" }, { status: 400 });
      }
      updateItemVerify(id, verified);
      return Response.json({ success: true });
    }

    if (path === "/api/sessions" && req.method === "GET") {
      const sessions = getAllSessions();
      return Response.json({ sessions, count: sessions.length });
    }

    if (path.startsWith("/api/sessions/") && path.endsWith("/toggle") && req.method === "POST") {
      const parts = path.split("/");
      const id = parts.length >= 4 ? decodeURIComponent(parts[3]) : "";
      if (!id || id === "toggle") return Response.json({ success: false }, { status: 400 });
      const updated = toggleSession(id);
      // Invalidate SSE session cache
      import("./sse-client").then(m => m.invalidateSessionCache?.()).catch(() => {});
      return Response.json({ success: true, session: updated });
    }

    if (path === "/api/sync" && req.method === "POST") {
      if (syncCallback && !appStatus.syncing) {
        setStatus({ syncing: true });
        syncCallback().finally(() => setStatus({ syncing: false }));
        return Response.json({ success: true, message: "Sync started" });
      }
      return Response.json({ success: false, message: "Sync already in progress" });
    }

    if (path === "/api/context" && req.method === "GET") {
      const talker = url.searchParams.get("talker");
      const aroundTime = parseInt(url.searchParams.get("t") || "0");
      if (!talker) return Response.json({ messages: [] });

      // Try local raw_messages first
      let msgs = getContextMessages(talker, aroundTime);

      // Fallback: if local store has no data, try WeFlow API (with retry)
      if (msgs.length === 0 && aroundTime > 0) {
        try {
          const dateFrom = new Date((aroundTime - 86400) * 1000).toISOString().split("T")[0];
          const qs = `talker=${talker}&date_from=${dateFrom}&limit=30`;
          const headers = { Authorization: `Bearer ${config.weflow.token}` };

          let res = await fetch(`${config.weflow.baseUrl}/api/v1/messages?${qs}`, { headers });
          if (!res.ok) throw new Error("WeFlow error");

          let data = await res.json();
          if (!data.messages || data.messages.length === 0) {
            await new Promise(r => setTimeout(r, 500));
            res = await fetch(`${config.weflow.baseUrl}/api/v1/messages?${qs}`, { headers });
            if (res.ok) data = await res.json();
          }

          msgs = (data.messages || [])
            .filter((m: any) => {
              if (m.localType !== 1) return false;
              const c = m.content || "";
              if (!c || c === "[消息]" || c.trim().length < 2) return false;
              if (c.includes("加入了群聊") || c.includes("退出了群聊") ||
                  c.includes("修改群名为") || c.includes("撤回了一条消息") ||
                  c.startsWith("<msg>") || c.startsWith("<sysmsg")) return false;
              return true;
            })
            .map((m: any) => {
              const wxid = m.senderUsername || "";
              const name = getContactName(wxid) || wxid || "未知";
              return {
                content: m.content.replace(/<[^>]*>/g, "").split("\n")[0].trim(),
                sender: name,
                time: m.createTime,
              };
            });
        } catch { /* fallback failed */ }
      }

      return Response.json({ messages: msgs });
    }

    if (path === "/api/summary" && req.method === "GET") {
      const digest = getLatestDigest();
      return Response.json(digest || { content: "", itemCount: 0, createdAt: "" });
    }

    if (path === "/api/status" && req.method === "GET") {
      return Response.json(getStatus());
    }

    // Static files
    if (path === "/" || path === "") {
      return new Response(Bun.file("ui/index.html"));
    }
    const file = Bun.file("ui" + path);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🚀 Campus Info Hub running at http://localhost:${config.server.port}`);

// Shared status
let appStatus = {
  lastSync: "",
  lastError: "",
  syncing: false,
  weflow: "reconnecting" as "online" | "reconnecting" | "offline",
};

let syncCallback: (() => Promise<void>) | null = null;

export function onSyncRequest(cb: () => Promise<void>) {
  syncCallback = cb;
}

export function getStatus() {
  const now = Date.now();
  return {
    lastSync: appStatus.lastSync,
    relativeSync: appStatus.lastSync
      ? relativeTimeStr(new Date(appStatus.lastSync).getTime(), now)
      : "从未同步",
    lastError: appStatus.lastError || null,
    syncing: appStatus.syncing,
    weflow: appStatus.weflow,
  };
}

export function setStatus(update: Partial<typeof appStatus>) {
  Object.assign(appStatus, update);
}

function relativeTimeStr(past: number, now: number): string {
  const diffSec = Math.floor((now - past) / 1000);
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  return `${Math.floor(diffSec / 86400)}天前`;
}

