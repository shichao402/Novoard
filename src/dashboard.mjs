/**
 * Dashboard v1（M2 · PRD-2 F3）：单页直出，无构建、无外部资源。
 * 能力：登录（口令）→ 触发（target + member 选择）→ target 目录（按成员分组）
 *   → 任务历史（状态、耗时、触发者；点击展开详情：artifacts / history）
 *   → 成员状态 → 审计流水。
 * 数据端点：/api/targets /api/tasks /api/events /api/status（均 Bearer）。
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
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 14px; color: #58a6ff; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #8b949e; font-weight: normal; padding: 6px 8px; border-bottom: 1px solid #30363d; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; vertical-align: top; }
  .on { color: #3fb950; }
  .off { color: #f85149; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; background: #21262d; }
  .badge.submitted { color: #d29922; }
  .badge.working { color: #58a6ff; }
  .badge.input-required { color: #d29922; }
  .badge.queued-offline { color: #d29922; }
  .badge.completed { color: #3fb950; }
  .badge.failed, .badge.rejected, .badge.canceled { color: #f85149; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .tilebtn { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 12px; cursor: pointer; text-align: left; transition: all .15s; }
  .tilebtn:hover { border-color: #238636; transform: translateY(-1px); }
  .tilebtn .t { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .tilebtn .m { color: #8b949e; font-size: 11px; }
  .tilebtn .st { font-size: 11px; margin-top: 4px; }
  .appr { background: #1f6feb; padding: 2px 10px; font-size: 12px; }
  .appr.rej { background: #da3633; }
  input, select { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
  button { background: #238636; border: none; color: #fff; border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  button.sec { background: #21262d; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #msg { font-size: 13px; color: #d29922; min-height: 18px; }
  .grp { margin-bottom: 12px; }
  .grp h3 { font-size: 13px; color: #e6edf3; margin-bottom: 6px; }
  .grp .sub2 { color: #8b949e; font-size: 12px; margin-left: 8px; }
  .skill { padding: 6px 10px; border: 1px solid #21262d; border-radius: 6px; margin-bottom: 6px; display: flex; gap: 10px; align-items: center; justify-content: space-between; }
  .skill .id { font-family: ui-monospace, monospace; color: #79c0ff; }
  .skill .desc { color: #8b949e; font-size: 12px; flex: 1; }
  .skill button { padding: 3px 10px; font-size: 12px; }
  details.task { border: 1px solid #21262d; border-radius: 6px; margin: 6px 0; padding: 0 10px; }
  details.task summary { cursor: pointer; padding: 8px 0; font-size: 13px; list-style: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  details.task[open] { padding-bottom: 10px; }
  .meta { color: #8b949e; font-size: 12px; }
  pre.log { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px; font-size: 12px; overflow-x: auto; margin-top: 8px; }
  .art { color: #79c0ff; font-size: 12px; text-decoration: none; }
</style>
</head>
<body>
<h1>Novoard hub</h1>
<div class="sub">联邦注册表 · 任务队列 · A2A 端点 · 隧道（契约 v1.1）</div>

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
    <h2>磁贴（快捷操作）</h2>
    <div class="tiles" id="tiles"></div>
  </section>

  <section>
    <h2>触发</h2>
    <div class="row">
      <input id="target" placeholder="target id" style="width: 240px" list="target-ids">
      <datalist id="target-ids"></datalist>
      <select id="member"><option value="">成员：自动</option></select>
      <button id="fire">触发</button>
    </div>
    <div id="msg"></div>
  </section>

  <section>
    <h2>Target 目录</h2>
    <div id="catalog"></div>
  </section>

  <section>
    <h2>任务历史</h2>
    <div id="tasks"></div>
  </section>

  <section>
    <h2>成员</h2>
    <table><thead><tr><th>agent</th><th>名称</th><th>状态</th><th>skills</th><th>最近心跳</th></tr></thead><tbody id="members"></tbody></table>
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

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function duration(task) {
  const from = Date.parse(task.createdAt), to = Date.parse(task.updatedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "-";
  const s = Math.round((to - from) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}

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
    const [status, catalog, tasks, events] = await Promise.all([
      api("/api/status").then((r) => r.json()),
      api("/api/targets").then((r) => r.json()),
      api("/api/tasks").then((r) => r.json()),
      api("/api/events").then((r) => r.json()),
    ]);

    // target 目录：按成员分组，离线成员灰显但可见
    $("catalog").innerHTML = (catalog.catalog || []).map((m) => {
      const skills = (m.skills || []).map((s) =>
        \`<div class="skill"><span class="id">\${esc(s.id)}</span><span class="desc">\${esc(s.description ?? s.name ?? "")}</span><button class="sec" onclick="fillTarget('\${esc(s.id)}', '\${esc(m.agentId)}')">触发</button></div>\`
      ).join("") || '<div class="meta">（无 a2a 技能）</div>';
      return \`<div class="grp"><h3>\${esc(m.name)} <span class="\${m.online ? "on" : "off"}">· \${m.online ? "online" : "offline"}</span><span class="sub2">\${esc(m.agentId)}</span></h3>\${skills}</div>\`;
    }).join("") || '<div class="meta">暂无成员注册</div>';

    // 磁贴分区：expose a2a 的 skills → 大按钮；input-required 任务 → 批准/拒绝按钮
    $("tiles").innerHTML = (catalog.catalog || []).flatMap((m) => (m.skills || []).map((s) => ({ ...s, member: m.agentId, memberName: m.name, online: m.online })))
      .map((s) => {
        const last = lastRunOf(s.id, tasks.tasks || []);
        const st = last ? \`<div class="st badge \${esc(last.state)}">\${esc(last.state)} · \${esc(new Date(last.updatedAt).toLocaleTimeString())}</div>\` : '<div class="st meta">未运行</div>';
        return \`<button class="tilebtn" \${s.online ? "" : 'disabled title="成员离线"'} onclick="fillTarget('\${esc(s.id)}', '\${esc(s.member)}'); fireTile()"><div class="t">\${esc(s.name ?? s.id)}</div><div class="m">\${esc(s.id)} @\${esc(s.memberName)}</div>\${st}</button>\`;
      }).join("") || '<div class="meta">暂无可触发能力</div>';
    const pending = (tasks.tasks || []).filter((t) => t.state === "input-required");
    if (pending.length) {
      $("tiles").innerHTML += \`<div style="grid-column: 1 / -1; margin-top:6px">\${pending.map((t) =>
        \`<div class="row" style="margin:4px 0"><span class="badge input-required">待审批</span><span>\${esc(t.target)}</span><span class="meta">\${esc(t.id)}</span><button class="appr" onclick="approveTask('\${esc(t.id)}', 'approve')">批准</button><button class="appr rej" onclick="approveTask('\${esc(t.id)}', 'reject')">拒绝</button></div>\`
      ).join("")}</div>\`;
    }
    const allSkills = (catalog.catalog || []).flatMap((m) => (m.skills || []).map((s) => s.id));
    $("target-ids").innerHTML = allSkills.map((id) => \`<option value="\${esc(id)}">\`).join("");
    const memberSel = $("member");
    const cur = memberSel.value;
    memberSel.innerHTML = '<option value="">成员：自动</option>' + (catalog.catalog || []).map((m) => \`<option value="\${esc(m.agentId)}">\${esc(m.name)}\${m.online ? "" : "（离线）"}</option>\`).join("");
    if ([...memberSel.options].some((o) => o.value === cur)) memberSel.value = cur;

    // 任务历史：状态/耗时/触发者 + 可展开详情
    $("tasks").innerHTML = (tasks.tasks || []).slice(0, 50).map((t) => {
      const arts = (t.artifacts || []).map((a) => {
        const uri = (a.parts || []).map((p) => p.uri).filter(Boolean)[0];
        return uri ? \`<a class="art" href="\${esc(uri)}" target="_blank">\${esc(a.name)}</a>\` : \`<span class="art">\${esc(a.name)}</span>\`;
      }).join("、") || '<span class="meta">无</span>';
      const hist = (t.history || []).map((h) => {
        const text = (h.parts || []).map((p) => p.text).filter(Boolean).join(" ");
        return \`[\${esc(h.ts)}] \${esc(h.role)}: \${esc(text)}\`;
      }).join("\\n") || "（无）";
      return \`<details class="task"><summary><span class="badge \${esc(t.state)}">\${esc(t.state)}</span><span>\${esc(t.target)}</span><span class="meta">@\${esc(t.member || "auto")}</span><span class="meta">· \${esc(t.actor)}</span><span class="meta">· \${duration(t)}</span><span class="meta">· \${esc(t.id)}</span></summary>
<div class="meta">创建 \${esc(t.createdAt)} · 更新 \${esc(t.updatedAt)}\${t.expiresAt ? " · 离线等待至 " + esc(t.expiresAt) : ""}</div>
<div class="meta" style="margin-top:6px">Artifacts：\${arts}</div>
<pre class="log">\${esc(hist)}</pre></details>\`;
    }).join("") || '<div class="meta">暂无任务</div>';

    $("members").innerHTML = (status.members || []).map((m) =>
      \`<tr><td>\${esc(m.agentId)}</td><td>\${esc(m.name)}</td><td class="\${m.online ? "on" : "off"}">\${m.online ? "online" : "offline"}</td><td>\${m.skillCount}</td><td>\${esc(m.lastSeen)}</td></tr>\`
    ).join("") || '<tr><td colspan="5" style="color:#8b949e">暂无成员注册</td></tr>';

    $("events").innerHTML = (events.events || []).slice(0, 30).map((e) =>
      \`<tr><td>\${esc(e.ts)}</td><td>\${esc(e.actor)}</td><td>\${esc(e.lane)}</td><td>\${esc(e.target)}</td><td>\${esc(e.outcome)}</td><td>\${esc(e.taskId ?? "")}</td></tr>\`
    ).join("") || '<tr><td colspan="6" style="color:#8b949e">暂无流水</td></tr>';
  } catch (error) {
    msg(error.message);
  }
}

window.fillTarget = (id, member) => {
  $("target").value = id;
  $("member").value = member;
  $("fire").focus();
};

window.fireTile = async () => { $("fire").click(); };

window.approveTask = async (id, decision) => {
  try {
    const res = await api("/a2a", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tasks/approve", params: { id, decision } }) });
    const body = await res.json();
    msg(body.result ? \`\${decision === "approve" ? "已批准" : "已拒绝"}：\${id} → \${body.result.status?.state ?? ""}\` : (body.error?.message ?? "审批失败"));
    refresh();
  } catch (error) { msg(error.message); }
};

function lastRunOf(skillId, tasks) {
  let last = null;
  for (const t of tasks) if (t.target === skillId && (!last || t.updatedAt > last.updatedAt)) last = t;
  return last;
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
  const member = $("member").value;
  try {
    const res = await api("/api/trigger", { method: "POST", body: JSON.stringify(member ? { target, member } : { target }) });
    const body = await res.json();
    if (body.state === "queued-offline") {
      msg(\`已入队等待成员上线：\${body.taskId}（等待至 \${body.expiresAt ?? "?"}）\`);
    } else if (body.state === "submitted") {
      msg(\`已受理：\${body.taskId}（\${body.state}）\`);
    } else if (body.state === "rejected") {
      msg(\`离线拒绝：\${body.reason ?? "member-offline"}（target offline: reject）\`);
    } else {
      msg(res.ok ? \`\${body.taskId ?? body.state}（\${body.state}）\` : (body.error || "触发失败"));
    }
    refresh();
  } catch (error) {
    msg(error.message);
  }
};

(async () => {
  const res = await fetch("/api/status");
  if (res.status === 423 || res.status === 401) {
    // 未初始化 or 未登录：均先进登录态；bootstrap 探测靠 session 401 细分
  }
  $("auth").hidden = false;
})();
</script>
</body>
html>`.replace("</body>\nhtml>", "</body>\n</html>");
}
