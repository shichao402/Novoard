/**
 * Dashboard 最小版（骨架）：单页直出，无构建、无外部资源。
 * 骨架期能力：登录（口令）→ 联邦状态 / 任务列表 / 审计流水三个只读视图 + 触发按钮。
 * 完备面板（agent 列表详情、target 目录树、实时日志）挂 M2（PRD-2 F3）。
 */
export function renderDashboard() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novoard hub</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 14px; color: #58a6ff; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #8b949e; font-weight: normal; padding: 6px 8px; border-bottom: 1px solid #30363d; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; }
  .on { color: #3fb950; }
  .off { color: #f85149; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #21262d; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  button { background: #238636; border: none; color: #fff; border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  button.sec { background: #21262d; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #msg { font-size: 13px; color: #d29922; min-height: 18px; }
</style>
</head>
<body>
<h1>Novoard hub</h1>
<div class="sub">联邦注册表 · 任务队列 · A2A 端点 · 隧道（契约 v1.0）</div>

<section id="auth" hidden>
  <h2>登录</h2>
  <div class="row">
    <input id="token" type="password" placeholder="管理口令" style="width: 220px">
    <button id="login">登录</button>
    <button id="bootstrap" class="sec" hidden>首次设置口令</button>
  </div>
  <div id="msg"></div>
</section>

<div id="main" hidden>
  <section>
    <h2>触发</h2>
    <div class="row">
      <input id="target" placeholder="target id（聚合 card 中的 skill id）" style="width: 280px">
      <button id="fire">触发</button>
    </div>
    <div id="msg"></div>
  </section>

  <section>
    <h2>成员</h2>
    <table><thead><tr><th>agent</th><th>名称</th><th>状态</th><th>skills</th><th>最近心跳</th></tr></thead><tbody id="members"></tbody></table>
  </section>

  <section>
    <h2>任务</h2>
    <table><thead><tr><th>taskId</th><th>target</th><th>member</th><th>state</th><th>更新时间</th></tr></thead><tbody id="tasks"></tbody></table>
  </section>

  <section>
    <h2>审计流水</h2>
    <table><thead><tr><th>时间</th><th>actor</th><th>lane</th><th>target</th><th>outcome</th><th>taskId</th></tr></thead><tbody id="events"></tbody></table>
  </section>
</div>

<script>
const $ = (id) => document.getElementById(id);
const state = { token: "" };

function msg(text) { $("msg").textContent = text || ""; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(state.token ? { Authorization: "Bearer " + state.token } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 423) throw new Error("未初始化：请先设置管理口令");
  return res;
}

async function refresh() {
  try {
    const [status, tasks, events] = await Promise.all([
      api("/api/status").then((r) => r.json()),
      api("/api/tasks").then((r) => r.json()),
      api("/api/events").then((r) => r.json()),
    ]);
    $("members").innerHTML = (status.members || []).map((m) =>
      \`<tr><td>\${m.agentId}</td><td>\${m.name}</td><td class="\${m.online ? "on" : "off"}">\${m.online ? "online" : "offline"}</td><td>\${m.skillCount}</td><td>\${m.lastSeen}</td></tr>\`
    ).join("") || '<tr><td colspan="5" style="color:#8b949e">暂无成员注册</td></tr>';
    $("tasks").innerHTML = (tasks.tasks || []).slice(0, 30).map((t) =>
      \`<tr><td>\${t.id}</td><td>\${t.target}</td><td>\${t.member}</td><td><span class="badge">\${t.state}</span></td><td>\${t.updatedAt}</td></tr>\`
    ).join("") || '<tr><td colspan="5" style="color:#8b949e">暂无任务</td></tr>';
    $("events").innerHTML = (events.events || []).slice(0, 30).map((e) =>
      \`<tr><td>\${e.ts}</td><td>\${e.actor}</td><td>\${e.lane}</td><td>\${e.target}</td><td>\${e.outcome}</td><td>\${e.taskId ?? ""}</td></tr>\`
    ).join("") || '<tr><td colspan="6" style="color:#8b949e">暂无流水</td></tr>';
  } catch (error) {
    msg(error.message);
  }
}

$("login").onclick = async () => {
  const token = $("token").value.trim();
  if (!token) return;
  const res = await fetch("/api/session", { method: "POST", headers: { Authorization: "Bearer " + token } });
  if (res.ok) {
    state.token = token;
    $("auth").hidden = true;
    $("main").hidden = false;
    refresh();
    setInterval(refresh, 5000);
  } else if (res.status === 401) {
    // 口令错误 or 未初始化：探测 bootstrap 可用性
    const probe = await fetch("/api/status").then((r) => r.status);
    if (probe === 423 || probe === 401) msg("口令错误或未初始化，请用首次设置口令");
  } else {
    msg("登录失败：" + res.status);
  }
};

$("bootstrap").onclick = async () => {
  const token = $("token").value.trim();
  if (token.length < 8) { msg("口令至少 8 位"); return; }
  const res = await fetch("/api/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (res.ok) { msg("口令已设置，请登录"); $("bootstrap").hidden = true; }
  else msg((await res.json()).error || "设置失败");
};

$("fire").onclick = async () => {
  const target = $("target").value.trim();
  if (!target) return;
  try {
    const res = await api("/api/trigger", { method: "POST", body: JSON.stringify({ target }) });
    const body = await res.json();
    msg(res.ok ? \`已受理：\${body.taskId ?? body.state}（\${body.state}）\` : (body.error || "触发失败"));
    refresh();
  } catch (error) {
    msg(error.message);
  }
};

// 首访探测：未设口令时显示 bootstrap 按钮
(async () => {
  const res = await fetch("/api/status");
  if (res.status === 423 || res.status === 401) {
    // 未初始化 or 未登录：均先进登录态；bootstrap 探测靠 session 401 细分
  }
  $("auth").hidden = false;
})();
</script>
</body>
</html>`;
}
