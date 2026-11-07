/**
 * 查看页面的静态资源。
 *
 * 页面随包内联，不加载任何外部资源；原文一律按纯文本渲染，避免 HTML 注入。
 */

export const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rehydra 脱敏记录</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 16px; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .muted { opacity: .7; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
  select, input, button { font: inherit; padding: 3px 6px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid rgba(128,128,128,.35); padding: 4px 6px; text-align: left; vertical-align: top; }
  th { cursor: pointer; user-select: none; }
  tr.row { cursor: pointer; }
  tr.row:hover td { background: rgba(128,128,128,.12); }
  pre { white-space: pre-wrap; word-break: break-all; margin: 0; padding: 8px; border: 1px solid rgba(128,128,128,.35); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .badge { padding: 1px 6px; border-radius: 6px; border: 1px solid rgba(128,128,128,.5); }
  .s-ok { border-color: #2a7; }
  .s-degraded { border-color: #c90; }
  .s-failed { border-color: #d33; color: #d33; }
  .s-blocked { border-color: #d33; color: #d33; }
  #detail { margin-top: 14px; }
  .warn { color: #d33; }
</style>
</head>
<body>
<h1>Rehydra 脱敏记录</h1>
<div class="muted" id="status">加载中…</div>
<div class="bar">
  <select id="fSession"></select>
  <select id="fSource">
    <option value="">全部来源</option>
    <option value="context">context</option>
    <option value="tool_result">tool_result</option>
    <option value="tool_call">tool_call</option>
    <option value="message_end">message_end</option>
  </select>
  <select id="fStatus">
    <option value="">全部状态</option>
    <option value="ok">ok</option>
    <option value="degraded">degraded</option>
    <option value="failed">failed</option>
    <option value="blocked">blocked</option>
  </select>
  <input id="fType" placeholder="类型，如 EMAIL" size="12" />
  <button id="reload">刷新</button>
  <button id="clearSession">清理当前会话</button>
  <button id="clearAll">清理全部</button>
</div>
<table>
  <thead><tr>
    <th data-sort="time">时间</th><th>来源</th><th>状态</th>
    <th>命中</th><th>类型</th><th>失败原因</th><th>会话</th><th>ID</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<div class="bar">
  <button id="prev">上一页</button><span id="pageInfo"></span><button id="next">下一页</button>
</div>
<div id="detail"></div>
<script>
(function () {
  var PAGE = 50;
  var offset = 0;
  var rows = [];
  var currentSession = "";

  function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ "x-rehydra-viewer": "1" }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function loadStatus() {
    return api("/api/status").then(function (data) {
      var parts = [
        "记录文件: " + (data.recordsDir || "-"),
        "记录: " + (data.recordsEnabled ? "开" : "关"),
        "原文保存: " + (data.includeOriginal ? "开" : "关"),
        "识别类型: " + (data.regexTypes || []).join(", "),
        "模型检测: " + (data.nerEnabled ? "开" : "关"),
        "失败策略: " + (data.nerFailure || "-")
      ];
      if (data.dropped && data.dropped > 0) {
        parts.push("未落盘记录: " + data.dropped);
      }
      if (data.error) parts.push("存储异常: " + data.error);
      document.getElementById("status").textContent = parts.join(" | ");
    });
  }

  function loadSessions() {
    return api("/api/sessions").then(function (data) {
      var select = document.getElementById("fSession");
      var previous = select.value;
      select.textContent = "";
      var all = el("option", "全部会话");
      all.value = "";
      select.appendChild(all);
      (data.sessions || []).forEach(function (item) {
        var option = el("option", item.sessionId + " (" + item.records + ")");
        option.value = item.sessionId;
        select.appendChild(option);
      });
      select.value = previous;
    });
  }

  function loadRecords() {
    var query = new URLSearchParams();
    query.set("limit", String(PAGE));
    query.set("offset", String(offset));
    var session = document.getElementById("fSession").value;
    var source = document.getElementById("fSource").value;
    var status = document.getElementById("fStatus").value;
    var type = document.getElementById("fType").value.trim();
    if (session) query.set("sessionId", session);
    if (source) query.set("source", source);
    if (status) query.set("status", status);
    if (type) query.set("type", type);
    return api("/api/records?" + query.toString()).then(function (data) {
      rows = data.records || [];
      var body = document.getElementById("rows");
      body.textContent = "";
      rows.forEach(function (row) {
        var tr = el("tr", undefined);
        tr.className = "row";
        tr.appendChild(el("td", row.time));
        tr.appendChild(el("td", row.source));
        var statusCell = el("td", undefined);
        var badge = el("span", row.status);
        badge.className = "badge s-" + row.status;
        statusCell.appendChild(badge);
        tr.appendChild(statusCell);
        tr.appendChild(el("td", String(row.masked)));
        tr.appendChild(el("td", (row.types || []).join(", ")));
        tr.appendChild(el("td", row.failure || ""));
        tr.appendChild(el("td", row.sessionId));
        tr.appendChild(el("td", row.id));
        tr.addEventListener("click", function () { showDetail(row.id); });
        body.appendChild(tr);
      });
      document.getElementById("pageInfo").textContent =
        "第 " + (offset / PAGE + 1) + " 页 · 共 " + (data.total === undefined ? "?" : data.total) + " 条";
    });
  }

  function showDetail(id) {
    api("/api/records/" + encodeURIComponent(id)).then(function (record) {
      var box = document.getElementById("detail");
      box.textContent = "";
      var title = el("div", "#" + record.id + " · " + record.source + " · " + record.time);
      box.appendChild(title);
      if (record.snapshot && record.snapshot.truncated) {
        box.appendChild(el("div", "内容超出单条预算，快照已截断。", undefined)).className = "warn";
      }
      if (record.failure) {
        box.appendChild(el("div", "脱敏失败并按当前策略放行：" + record.failure, undefined)).className = "warn";
      }
      var cols = el("div", undefined);
      cols.className = "cols";
      var left = el("div", undefined);
      left.appendChild(el("div", "扩展收到的内容"));
      left.appendChild(el("pre", record.snapshot ? record.snapshot.before : "(未保存原文)"));
      var right = el("div", undefined);
      right.appendChild(el("div", "扩展输出的内容"));
      right.appendChild(el("pre", record.snapshot ? record.snapshot.after : "(未保存原文)"));
      cols.appendChild(left);
      cols.appendChild(right);
      box.appendChild(cols);

      var hits = el("table", undefined);
      var head = el("tr", undefined);
      ["类型", "发现方式", "检测器", "占位符", "原值"].forEach(function (title) {
        head.appendChild(el("th", title));
      });
      hits.appendChild(head);
      (record.hits || []).forEach(function (hit) {
        var tr = el("tr", undefined);
        tr.appendChild(el("td", hit.type));
        tr.appendChild(el("td", hit.finder));
        tr.appendChild(el("td", hit.label || hit.detector));
        tr.appendChild(el("td", hit.placeholder));
        tr.appendChild(el("td", hit.original === undefined ? "(未保存)" : hit.original));
        hits.appendChild(tr);
      });
      box.appendChild(el("div", "命中明细"));
      box.appendChild(hits);
    });
  }

  function clear(kind) {
    var sessionId = document.getElementById("fSession").value;
    // 没有选中会话时，"清理当前会话"没有目标，按清理全部处理并在确认文案里说明。
    var scope = kind === "all" || sessionId === "" ? "all" : "session";
    var label = scope === "all" ? "全部记录" : "会话 " + sessionId + " 的记录";
    if (!window.confirm("确认删除" + label + "？该操作不可撤销。")) return;
    api("/api/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: scope, sessionId: sessionId, confirm: true })
    }).then(function (data) {
      window.alert("已删除 " + (data.deleted || 0) + " 条记录");
      offset = 0;
      return refresh();
    });
  }

  function refresh() {
    return Promise.all([loadStatus(), loadSessions(), loadRecords()]).catch(function (error) {
      document.getElementById("status").textContent = "加载失败：" + error.message;
    });
  }

  document.getElementById("reload").addEventListener("click", function () { refresh(); });
  document.getElementById("fSession").addEventListener("change", function () { offset = 0; loadRecords(); });
  document.getElementById("fSource").addEventListener("change", function () { offset = 0; loadRecords(); });
  document.getElementById("fStatus").addEventListener("change", function () { offset = 0; loadRecords(); });
  document.getElementById("fType").addEventListener("change", function () { offset = 0; loadRecords(); });
  document.getElementById("prev").addEventListener("click", function () {
    offset = Math.max(0, offset - PAGE); loadRecords();
  });
  document.getElementById("next").addEventListener("click", function () {
    if (rows.length < PAGE) return; offset += PAGE; loadRecords();
  });
  document.getElementById("clearSession").addEventListener("click", function () { clear("session"); });
  document.getElementById("clearAll").addEventListener("click", function () { clear("all"); });

  refresh();
  setInterval(function () { loadRecords(); }, 2000);
})();
</script>
</body>
</html>
`;
