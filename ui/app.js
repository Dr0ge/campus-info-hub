// ── State ──
let currentCategory = "全部";
let currentVerified = "unverified"; // "all" | "unverified" | "useful" | "ignored"
let refreshIntervalSec = 300;
let hiddenCategories = [];
let disabledSessions = new Set();
let refreshTimer = null;
let sessionToggleBusy = false;
let selectAllBusy = false;
let fetchSeq = 0;

// ── Elements (additional) ──
const $digestBanner = document.getElementById("digest-banner");
const $digestContent = document.getElementById("digest-content");

// ── Elements ──
const $nav = document.getElementById("category-nav");
const $content = document.getElementById("content");
const $itemsContainer = document.getElementById("items-container");
const $loadingState = document.getElementById("loading-state");
const $emptyState = document.getElementById("empty-state");
const $filteredEmptyState = document.getElementById("filtered-empty-state");
const $statusText = document.getElementById("status-text");
const $statusIndicator = document.getElementById("status-indicator");
const $settingsModal = document.getElementById("settings-modal");
const $refreshInterval = document.getElementById("refresh-interval");
const $ignoredLink = document.getElementById("ignored-link");
const $settingsLink = document.getElementById("settings-link");
const $settingsSave = document.getElementById("settings-save");
const $settingsClose = document.getElementById("settings-close");
const $syncBtn = document.getElementById("sync-btn");
const $settingsLinkTop = document.getElementById("settings-link-top");
const $sessionList = document.getElementById("session-list");

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  fetchData();
  startRefreshTimer();
  setupEvents();
});

// ── Events ──
function setupEvents() {
  $nav.addEventListener("click", (e) => {
    const link = e.target.closest(".cat-link");
    if (!link) return;
    e.preventDefault();
    currentCategory = link.dataset.category;
    currentVerified = link.dataset.verified || "unverified";
    updateActiveNav();
    fetchData();
  });

  // "查看全部" link in filtered-empty-state
  $content.addEventListener("click", (e) => {
    const link = e.target.closest(".reset-filter-link");
    if (!link) return;
    e.preventDefault();
    currentCategory = "全部";
    currentVerified = "unverified";
    updateActiveNav();
    fetchData();
  });

  $ignoredLink.addEventListener("click", (e) => {
    e.preventDefault();
    currentCategory = "全部";
    currentVerified = "ignored";
    updateActiveNav();
    fetchData();
  });

  function openSettings(e) {
    e.preventDefault();
    $settingsModal.classList.remove("hidden");
    loadSessions();
  }
  $settingsLink.addEventListener("click", openSettings);
  $settingsLinkTop.addEventListener("click", openSettings);

  // Session toggle delegation
  $sessionList.addEventListener("change", async (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb || !cb.dataset.talker) return;
    if (sessionToggleBusy) return; // Skip cascading events from select-all
    const talker = cb.dataset.talker;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(talker)}/toggle`, { method: "POST" });
      const data = await res.json();
      if (data.success && data.session) {
        cb.checked = data.session.enabled === 1;
      }
    } catch (err) {
      console.error("Toggle session error:", err);
    }
    // Refresh data after each toggle so user sees immediate effect
    await refreshSessionFilter();
    fetchData();
  });

  $settingsSave.addEventListener("click", () => {
    saveSettings();
    $settingsModal.classList.add("hidden");
    startRefreshTimer();
    fetchData();
  });

  $settingsClose.addEventListener("click", () => {
    $settingsModal.classList.add("hidden");
  });

  $settingsModal.addEventListener("click", (e) => {
    if (e.target === $settingsModal) $settingsModal.classList.add("hidden");
  });

  $syncBtn.addEventListener("click", async () => {
    if ($syncBtn.disabled) return;
    $syncBtn.disabled = true;
    $syncBtn.textContent = "同步中...";
    try {
      await fetch("/api/sync", { method: "POST" });
      // Wait a moment then refresh
      setTimeout(() => {
        fetchData();
        $syncBtn.disabled = false;
        $syncBtn.textContent = "立即同步";
      }, 2000);
    } catch {
      $syncBtn.disabled = false;
      $syncBtn.textContent = "立即同步";
    }
  });

  // Item actions delegation
  $itemsContainer.addEventListener("click", (e) => {
    // Handle quote toggle (div, not button)
    const toggle = e.target.closest(".card-quote-toggle");
    if (toggle) {
      const card = toggle.closest(".item-card");
      const quote = card.querySelector(".card-quote");
      const isOpen = !quote.classList.contains("open");
      quote.classList.toggle("open");
      toggle.textContent = isOpen ? "▲ 原文引用" : "▼ 原文引用";

      // Fetch context on first expand
      if (isOpen) {
        const ctxDiv = card.querySelector(".card-quote-context");
        if (ctxDiv && ctxDiv.classList.contains("hidden")) {
          ctxDiv.classList.remove("hidden");
          const talker = card.dataset.talker;
          const msgTime = card.dataset.msgtime;
          if (talker) {
            fetchContext(ctxDiv, talker, parseInt(msgTime) || 0);
          } else {
            ctxDiv.innerHTML = '<p class="text-muted">缺少群聊ID，无法加载上下文（旧数据不支持）</p>';
          }
        }
      }
      return;
    }

    const btn = e.target.closest("button");
    if (!btn) return;

    const card = btn.closest(".item-card");
    if (!card) return;

    const id = card.dataset.id;

    if (btn.classList.contains("btn-useful")) {
      verifyItem(id, 1, card);
    } else if (btn.classList.contains("btn-ignore")) {
      verifyItem(id, -1, card);
    }
  });
}

// ── Fetch ──
async function fetchData() {
  const seq = ++fetchSeq;
  $emptyState.classList.add("hidden");
  $filteredEmptyState.classList.add("hidden");

  // Refresh session filter BEFORE rendering (Bug #3 fix)
  await refreshSessionFilter();

  const params = new URLSearchParams();
  if (currentCategory !== "全部") params.set("category", currentCategory);
  params.set("verified", currentVerified);

  try {
    const res = await fetch(`/api/items?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== fetchSeq) return; // Discard stale response (Bug #2 fix)

    updateStatus(data.status);
    const visible = renderItems(data.items);
    renderNav(data.categories, visible, data.ignoredCount);
    fetchDigest();
  } catch (err) {
    console.error("Fetch error:", err);
    $statusIndicator.className = "status offline";
    $statusText.textContent = "🔴 连接失败 · 上次同步 —";
  }
}

// ── Render Nav ──
function renderNav(categories, visibleItems, ignoredCount) {
  // Compute filtered counts from visible items
  const visCounts = { "全部": visibleItems.length };
  for (const item of visibleItems) {
    visCounts[item.category] = (visCounts[item.category] || 0) + 1;
  }

  let html = "";
  for (const cat of categories) {
    const total = cat.count;
    const filtered = visCounts[cat.key] || 0;
    const countStr = filtered < total ? `${filtered}/${total}` : `${total}`;
    const isActive = cat.key === currentCategory && currentVerified !== "ignored";
    html += `
      <a href="#" class="cat-link${isActive ? " active" : ""}" data-category="${cat.key}" data-verified="unverified">
        ${esc(cat.key)}
        <span class="cat-count">${countStr}</span>
      </a>`;
  }
  $nav.innerHTML = html;

  if (ignoredCount !== undefined) {
    $ignoredLink.textContent = `已忽略 (${ignoredCount})`;
  }
}

function updateActiveNav() {
  document.querySelectorAll(".cat-link").forEach(el => {
    const match = el.dataset.category === currentCategory && el.dataset.verified === currentVerified;
    el.classList.toggle("active", match);
  });
  const ignoredActive = currentVerified === "ignored";
  $ignoredLink.style.fontWeight = ignoredActive ? "600" : "";
  $ignoredLink.style.color = ignoredActive ? "var(--accent)" : "";
}

// ── Render Items ──
function renderItems(items) {
  $loadingState.classList.add("hidden");

  // Filter out hidden categories and disabled sessions
  const visible = items.filter(item => {
    if (hiddenCategories.includes(item.category)) return false;
    if (disabledSessions.has(item.source_group)) return false;
    if (item.session_id && disabledSessions.has(item.session_id)) return false;
    return true;
  });

  if (visible.length === 0) {
    $itemsContainer.innerHTML = "";
    if (currentCategory === "全部" && currentVerified === "unverified") {
      $emptyState.classList.remove("hidden");
    } else {
      $filteredEmptyState.classList.remove("hidden");
    }
    return [];
  }

  let html = "";
  for (const item of visible) {
    html += renderCard(item);
  }
  $itemsContainer.innerHTML = html;
  return visible;
}

function renderCard(item) {
  const verifiedClass = item.is_verified === 1 ? "verified" : item.is_verified === -1 ? "ignored" : "";
  const metaParts = [];
  if (item.event_date) metaParts.push(`<span>${esc(item.event_date)}</span>`);
  if (item.location) metaParts.push(`<span>${esc(item.location)}</span>`);
  if (item.organizer) metaParts.push(`<span>${esc(item.organizer)}</span>`);
  metaParts.push(`<span>${esc(item.source_group)}</span>`);

  const msgTime = item.msg_time
    ? new Date(item.msg_time * 1000).toLocaleString("zh-CN")
    : (item.created_at ? new Date(item.created_at).toLocaleString("zh-CN") : "");

  return `
    <div class="item-card ${verifiedClass}" data-id="${item.id}" data-category="${esc(item.category)}" data-talker="${esc(item.session_id || "")}" data-msgtime="${item.msg_time || (item.created_at ? Math.floor(new Date(item.created_at).getTime()/1000) : "")}">
      <div class="card-header">
        <span class="card-category" data-cat="${esc(item.category)}">${esc(item.category)}</span>
        <span class="card-time">${esc(item.relativeTime)}</span>
      </div>
      <div class="card-title">${esc(item.title)}</div>
      ${metaParts.length ? `<div class="card-meta">${metaParts.join(" · ")}</div>` : ""}
      <div class="card-quote-toggle">▼ 原文引用</div>
      <div class="card-quote">
        <div class="card-quote-main">
          <div class="quote-meta">${esc(item.sender_name || '未知')} · ${msgTime} · ${esc(item.source_group)}</div>
          <div class="quote-text">${esc(item.source_quote)}</div>
        </div>
        <div class="card-quote-context hidden">
          <p class="text-muted">加载上下文中...</p>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-useful${item.is_verified === 1 ? " active" : ""}">有用</button>
        <button class="btn-ignore${item.is_verified === -1 ? " active" : ""}">忽略</button>
      </div>
    </div>`;
}

// ── Verify ──
async function verifyItem(id, verified, cardEl) {
  try {
    const res = await fetch(`/api/items/${id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verified }),
    });
    if (res.ok) {
      if (verified === 1) {
        if (currentVerified === "ignored") {
          // Card no longer matches current filter → remove
          cardEl.style.transition = "opacity 0.3s";
          cardEl.style.opacity = "0";
          setTimeout(() => cardEl.remove(), 300);
        } else {
          cardEl.classList.add("verified");
          cardEl.querySelector(".btn-useful").classList.add("active");
          cardEl.querySelector(".btn-ignore").classList.remove("active");
        }
      } else {
        if (currentVerified !== "ignored") {
          cardEl.style.transition = "opacity 0.3s";
          cardEl.style.opacity = "0";
          setTimeout(() => cardEl.remove(), 300);
        } else {
          cardEl.querySelector(".btn-ignore").classList.add("active");
          cardEl.querySelector(".btn-useful").classList.remove("active");
        }
      }
    }
  } catch (err) {
    console.error("Verify error:", err);
  }
}

// ── Status ──
function updateStatus(status) {
  if (status.syncing) {
    $statusIndicator.className = "status reconnecting";
    $statusText.textContent = `🔄 同步中...`;
    return;
  }
  const icons = { online: "🟢", reconnecting: "🟡", offline: "🔴" };
  const labels = { online: "在线", reconnecting: "重连中", offline: "离线" };
  const wf = status.weflow || "offline";
  $statusIndicator.className = `status ${wf}`;
  $statusText.textContent = `${icons[wf]} WeFlow ${labels[wf]} · 上次同步 ${status.relativeSync}`;
}

// ── Timer ──
function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchData, refreshIntervalSec * 1000);
}

// ── Context ──

async function fetchContext(ctxDiv, talker, aroundTime) {
  try {
    const res = await fetch(`/api/context?talker=${encodeURIComponent(talker)}&t=${aroundTime || 0}`);
    const data = await res.json();
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      ctxDiv.innerHTML = '<p class="text-muted">无上下文</p>';
      return;
    }
    ctxDiv.innerHTML = '<div class="ctx-label">附近消息</div>' + msgs.map(m => {
      const t = new Date(m.time * 1000).toLocaleString("zh-CN");
      const isTarget = Math.abs(m.time - (aroundTime || 0)) < 60;
      const cls = isTarget ? "ctx-msg ctx-target" : "ctx-msg";
      const text = (m.content || "").replace(/<[^>]*>/g, "").split("\n")[0].trim();
      if (!text) return "";
      return `<div class="${cls}"><span class="ctx-sender">${esc(m.sender)}</span> <span class="ctx-time">${t}</span><br>${esc(text)}</div>`;
    }).join("");
  } catch {
    ctxDiv.innerHTML = '<p class="text-muted">加载失败</p>';
  }
}

// ── Digest ──

async function fetchDigest() {
  try {
    const res = await fetch("/api/summary");
    const digest = await res.json();
    if (digest && digest.content) {
      $digestContent.textContent = digest.content;
      $digestBanner.classList.remove("hidden");
    } else {
      $digestBanner.classList.add("hidden");
    }
  } catch {
    $digestBanner.classList.add("hidden");
  }
}

async function refreshSessionFilter() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    const next = new Set();
    for (const s of (data.sessions || [])) {
      if (!s.enabled) {
        next.add(s.name);
        next.add(s.talker); // Also block by talker (SSE items may use talker as source_group)
      }
    }
    disabledSessions = next; // Only update on success
  } catch { /* keep existing filter on failure */ }
}

// ── Sessions ──

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    renderSessions(data.sessions || []);
  } catch (err) {
    $sessionList.innerHTML = '<p class="text-muted">加载失败</p>';
  }
}

function renderSessions(sessions) {
  if (sessions.length === 0) {
    $sessionList.innerHTML = '<p class="text-muted">暂无群聊，等待同步后自动发现</p>';
    return;
  }
  const allEnabled = sessions.every(s => s.enabled);
  const html = [
    `<label class="session-row session-row-all">
      <input type="checkbox" id="session-select-all" ${allEnabled ? "checked" : ""}>
      <span>全选</span>
    </label>`,
    ...sessions.map(s => `
      <label class="session-row">
        <input type="checkbox" data-talker="${esc(s.talker)}" ${s.enabled ? "checked" : ""}>
        <span>${esc(s.name)}</span>
        <span class="text-muted" style="font-size:11px">${esc(s.is_group ? '群' : '私')} ${esc(s.talker.substring(0, 15))}...</span>
      </label>
    `)
  ].join("");
  $sessionList.innerHTML = html;

  // Select all handler (Bug #1/#6 fix: re-entry guard, parallel toggles)
  document.getElementById("session-select-all").addEventListener("change", async (e) => {
    if (selectAllBusy) return;
    selectAllBusy = true;
    sessionToggleBusy = true;
    const check = e.target.checked;
    try {
      const promises = [];
      const checkboxes = $sessionList.querySelectorAll("input[data-talker]");
      for (const cb of checkboxes) {
        if (cb.checked !== check) {
          cb.checked = check;
          promises.push(
            fetch(`/api/sessions/${encodeURIComponent(cb.dataset.talker)}/toggle`, { method: "POST" }).catch(() => {})
          );
        }
      }
      await Promise.all(promises);
    } finally {
      sessionToggleBusy = false;
      selectAllBusy = false;
    }
    await refreshSessionFilter();
    fetchData();
  });
}

// ── Settings ──
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("campus-hub-settings") || "{}");
    refreshIntervalSec = Math.max(30, parseInt(saved.refreshInterval, 10) || 300);
    hiddenCategories = Array.isArray(saved.hiddenCategories) ? saved.hiddenCategories : [];
  } catch { /* ignore */ }
  $refreshInterval.value = refreshIntervalSec;

  // Apply saved category toggles
  document.querySelectorAll("#category-toggles input").forEach(cb => {
    cb.checked = !hiddenCategories.includes(cb.dataset.cat);
  });
}

function saveSettings() {
  refreshIntervalSec = Math.max(30, parseInt($refreshInterval.value) || 300);
  $refreshInterval.value = refreshIntervalSec;

  // Collect hidden categories
  hiddenCategories = [];
  document.querySelectorAll("#category-toggles input").forEach(cb => {
    if (!cb.checked) hiddenCategories.push(cb.dataset.cat);
  });

  localStorage.setItem("campus-hub-settings", JSON.stringify({
    refreshInterval: refreshIntervalSec,
    hiddenCategories,
  }));
}

// ── Helpers ──
function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
