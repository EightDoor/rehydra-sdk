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
  :root {
    color-scheme: light;
    --bg: #f4f6f9;
    --panel: #ffffff;
    --line: #e2e6ee;
    --text: #1c2230;
    --muted: #667085;
    --accent: #2563eb;
    --accent-soft: #eaf0ff;
    --ok: #15803d;
    --warn: #b45309;
    --bad: #b91c1c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  code, pre, .mono, th, td { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 14px 20px; }
  .head { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
  h1 { font-size: 16px; margin: 0; }
  .hint { color: var(--muted); font-size: 12px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid var(--line); background: #fafbfd;
    border-radius: 999px; padding: 2px 9px; font-size: 12px; color: var(--muted);
  }
  .chip.on { border-color: #bfd3ff; background: var(--accent-soft); color: var(--accent); }
  .chip.bad { border-color: #f3c0c0; background: #fdf0f0; color: var(--bad); }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 20px; }
  select, input, button {
    font: inherit; font-size: 13px; color: var(--text);
    background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px;
  }
  select:focus, input:focus, button:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
  button { cursor: pointer; }
  button:hover { border-color: #c3ccdd; background: #fbfcfe; }
  button.primary { border-color: var(--accent); color: var(--accent); }
  button.danger { color: var(--bad); border-color: #f0c4c4; }
  button.danger:hover { background: #fdf2f2; }
  .wrap { display: grid; grid-template-columns: 430px minmax(0, 1fr); gap: 16px; padding: 4px 20px 28px; align-items: start; }
  @media (max-width: 1080px) {
    .wrap { grid-template-columns: 1fr; }
    .detail { position: static !important; max-height: none !important; }
    .list-scroll { max-height: 45vh; }
  }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .list-panel { overflow: hidden; }
  .list-scroll { overflow: auto; max-height: calc(100vh - 210px); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { position: sticky; top: 0; background: #fafbfd; color: var(--muted); font-weight: 600; font-size: 12px; }
  tr.row { cursor: pointer; }
  tr.row:hover td { background: #f7f9fd; }
  tr.row.selected td { background: var(--accent-soft); }
  tr.row.selected td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
  .cell-time { white-space: nowrap; color: var(--muted); font-size: 12px; }
  #rows td { word-break: break-word; }
  #rows td:nth-child(2) { font-size: 12px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 6px; border: 1px solid var(--line); font-size: 11.5px; }
  .b-ok { border-color: #b6e0c4; color: var(--ok); }
  .b-degraded { border-color: #f0d9a8; color: var(--warn); }
  .b-failed, .b-blocked { border-color: #f3c0c0; color: var(--bad); }
  .b-captured { border-color: #bfd3ff; color: var(--accent); }
  .pager { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .detail { position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow: auto; }
  .detail-head { padding: 12px 14px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .detail-head .id { font-weight: 600; }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  .tools label { display: inline-flex; gap: 5px; align-items: center; color: var(--muted); font-size: 12px; }
  .tools .grow { flex: 1; min-width: 120px; }
  .detail-body { padding: 12px 14px 16px; }
  .note { padding: 8px 10px; border-radius: 8px; font-size: 12.5px; margin-bottom: 10px; }
  .note.info { background: #f2f6ff; border: 1px solid #d8e3ff; color: #23417d; }
  .note.warn { background: #fff8ec; border: 1px solid #f0dcb4; color: #7a4c07; }
  .note.bad { background: #fdf1f1; border: 1px solid #f2c9c9; color: var(--bad); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 1400px) { .cols { grid-template-columns: 1fr; } }
  .pane-title { font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  pre {
    margin: 0; padding: 10px 12px; background: #fbfcfe; border: 1px solid var(--line); border-radius: 8px;
    white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 46vh;
  }
  body.nowrap pre { white-space: pre; word-break: normal; }
  pre mark { background: #ffe58a; color: inherit; }
  .section-title { margin: 16px 0 6px; font-size: 12.5px; color: var(--muted); font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .empty { padding: 28px 16px; text-align: center; color: var(--muted); }
  #detail-empty { padding: 40px 16px; }
</style>
</head>
<body>
<header>
  <div class="head">
    <h1>Rehydra 脱敏记录</h1>
    <span class="hint">仅本机访问 · 页面明文展示记录内容</span>
  </div>
  <div class="badges" id="status">加载中…</div>
</header>
<div class="bar">
  <select id="fSession" title="会话"></select>
  <select id="fSource" title="来源">
    <option value="">全部来源</option>
    <option value="context">context</option>
    <option value="tool_result">tool_result</option>
    <option value="tool_call">tool_call</option>
    <option value="message_end">message_end</option>
    <option value="provider_request">provider_request</option>
  </select>
  <select id="fStatus" title="状态">
    <option value="">全部状态</option>
    <option value="ok">ok</option>
    <option value="degraded">degraded</option>
    <option value="failed">failed</option>
    <option value="blocked">blocked</option>
  </select>
  <input id="fType" placeholder="类型，如 EMAIL" size="12" />
  <button id="reload" class="primary">刷新</button>
  <button id="clearSession" class="danger">清理当前会话</button>
  <button id="clearAll" class="danger">清理全部</button>
</div>
<div class="wrap">
  <div class="panel list-panel">
    <div class="list-scroll">
      <table>
        <thead><tr><th>时间</th><th>来源</th><th>状态</th><th>命中</th><th>类型</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div id="list-empty" class="empty" hidden>暂无记录</div>
    </div>
    <div class="pager">
      <button id="prev">上一页</button>
      <span id="pageInfo"></span>
      <button id="next">下一页</button>
    </div>
  </div>
  <div class="panel detail" id="detail">
    <div class="detail-body" id="detail-empty">
      <div class="empty">选择左侧记录查看内容</div>
    </div>
  </div>
</div>
<script>
(function () {
  var PAGE = 50;
  var offset = 0;
  var rows = [];
  var selectedId = "";
  var detailToken = 0;

  function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ "x-rehydra-viewer": "1" }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function el(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function formatJson(text) {
    if (typeof text !== "string") return String(text);
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (error) {
      return text;
    }
  }

  function statusLabel(row) {
    if (row.source === "provider_request") return "captured";
    return row.status;
  }

  function statusClass(row) {
    if (row.source === "provider_request") return "b-captured";
    return "b-" + row.status;
  }

  function loadStatus() {
    return api("/api/status").then(function (data) {
      var box = document.getElementById("status");
      box.textContent = "";
      function chip(text, on, bad) {
        var node = el("span", text, "chip" + (on ? " on" : "") + (bad ? " bad" : ""));
        box.appendChild(node);
      }
      chip(data.recordsEnabled ? "记录已开启" : "记录已关闭", data.recordsEnabled === true);
      chip(data.includeOriginal ? "保存原文" : "不保存原文", data.includeOriginal === true);
      chip("模型检测" + (data.nerEnabled ? "开" : "关"), data.nerEnabled === true);
      if (data.dropped) chip("未落盘 " + data.dropped + " 条", false, true);
      if (data.error) chip("存储异常: " + data.error, false, true);
      var hint = el("span", "记录文件: " + (data.recordsDir || "-") + " · 失败策略: " + (data.nerFailure || "-"), "chip");
      hint.title = (data.regexTypes || []).join(", ");
      box.appendChild(hint);
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

  function highlightSelected() {
    var trs = document.getElementById("rows").children;
    for (var i = 0; i < trs.length; i += 1) {
      var tr = trs[i];
      if (tr.getAttribute("data-id") === selectedId) tr.className = "row selected";
      else tr.className = "row";
    }
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
        var tr = el("tr", undefined, "row");
        tr.setAttribute("data-id", row.id);
        var timeCell = el("td", row.time.slice(11, 23), "cell-time");
        timeCell.title = row.time;
        tr.appendChild(timeCell);
        tr.appendChild(el("td", row.source));
        var statusCell = el("td", undefined);
        statusCell.appendChild(el("span", statusLabel(row), "badge " + statusClass(row)));
        tr.appendChild(statusCell);
        tr.appendChild(el("td", row.source === "provider_request" ? "-" : String(row.masked)));
        tr.appendChild(el("td", (row.types || []).join(", ")));
        tr.addEventListener("click", function () { selectRecord(row.id); });
        body.appendChild(tr);
      });
      document.getElementById("list-empty").hidden = rows.length > 0;
      document.getElementById("pageInfo").textContent =
        "第 " + (offset / PAGE + 1) + " 页 · 共 " + (data.total === undefined ? "?" : data.total) + " 条";
      highlightSelected();
      if (selectedId === "" && rows.length > 0) selectRecord(rows[0].id);
    });
  }

  function selectRecord(id) {
    selectedId = id;
    highlightSelected();
    detailToken += 1;
    var token = detailToken;
    api("/api/records/" + encodeURIComponent(id)).then(function (record) {
      if (token !== detailToken) return;
      renderDetail(record);
    }).catch(function (error) {
      if (token !== detailToken) return;
      renderMessage("bad", "读取记录失败：" + error.message + "（记录可能已被清理）");
    });
  }

  function renderMessage(kind, text) {
    var detail = document.getElementById("detail");
    detail.textContent = "";
    var body = el("div", undefined, "detail-body");
    body.appendChild(el("div", text, "note " + kind));
    detail.appendChild(body);
  }

  function addPre(parent, label, text) {
    var wrap = el("div");
    wrap.appendChild(el("div", label, "pane-title"));
    var pre = el("pre", formatJson(text));
    pre.setAttribute("data-raw", pre.textContent);
    wrap.appendChild(pre);
    parent.appendChild(wrap);
    return pre;
  }

  function hitsTable(hits) {
    var table = el("table");
    var head = el("tr");
    ["类型", "发现方式", "检测器", "占位符", "原值"].forEach(function (title) {
      head.appendChild(el("th", title));
    });
    table.appendChild(head);
    hits.forEach(function (hit) {
      var tr = el("tr");
      tr.appendChild(el("td", hit.type));
      tr.appendChild(el("td", hit.finder));
      tr.appendChild(el("td", hit.label || hit.detector));
      tr.appendChild(el("td", hit.placeholder));
      tr.appendChild(el("td", hit.original === undefined ? "（未保存）" : hit.original));
      table.appendChild(tr);
    });
    return table;
  }

  function comparisonsTable(items) {
    var table = el("table");
    var head = el("tr");
    ["字段路径", "原文", "脱敏后"].forEach(function (title) { head.appendChild(el("th", title)); });
    table.appendChild(head);
    items.forEach(function (item) {
      var tr = el("tr");
      tr.appendChild(el("td", item.path));
      tr.appendChild(el("td", item.before));
      tr.appendChild(el("td", item.after + (item.truncated ? "（截断）" : "")));
      table.appendChild(tr);
    });
    return table;
  }

  function renderDetail(record) {
    var detail = document.getElementById("detail");
    detail.textContent = "";

    var head = el("div", undefined, "detail-head");
    head.appendChild(el("span", "#" + record.id, "id mono"));
    head.appendChild(el("span", record.source, "badge " + statusClass(record)));
    head.appendChild(el("span", record.time, "meta"));
    head.appendChild(el("span", "会话 " + record.sessionId, "meta"));
    head.appendChild(el("span", "耗时 " + record.durationMs + "ms", "meta"));
    if (record.masked) head.appendChild(el("span", "命中 " + record.masked, "meta"));
    detail.appendChild(head);

    var tools = el("div", undefined, "tools");
    var wrapLabel = el("label");
    var wrapToggle = document.createElement("input");
    wrapToggle.type = "checkbox";
    wrapToggle.id = "wrapToggle";
    wrapLabel.appendChild(wrapToggle);
    wrapLabel.appendChild(document.createTextNode("自动换行"));
    tools.appendChild(wrapLabel);

    var find = document.createElement("input");
    find.id = "findBox";
    find.className = "grow";
    find.placeholder = "在当前内容中查找";
    tools.appendChild(find);
    tools.appendChild(el("span", "0 处", "meta")).id = "findCount";

    var copy = el("button", "复制内容");
    copy.id = "copyButton";
    tools.appendChild(copy);
    detail.appendChild(tools);

    var body = el("div", undefined, "detail-body");
    detail.appendChild(body);

    if (record.failure) {
      body.appendChild(el("div", "脱敏失败并按当前策略放行：" + record.failure, "note warn"));
    }
    if (record.integrity === "rules-only") {
      body.appendChild(el("div", "模型检测不可用，本次仅规则脱敏。", "note warn"));
    }
    if (record.relatedEvents && record.relatedEvents.length > 0) {
      body.appendChild(el("div", "关联事件（不是独立模型请求）：" +
        record.relatedEvents.map(function (item) { return item.kind + (item.code ? " (" + item.code + ")" : ""); }).join(", "),
        "note info"));
    }

    if (record.providerPayload) {
      if (record.providerPayload.truncated) {
        body.appendChild(el("div", "内容超出单条预算，请求体已截断。", "note warn"));
      }
      body.appendChild(el("div",
        "这是发送前钩子（before_provider_request）采集的供应商请求体。后加载的扩展仍可能改写载荷，采集也不代表网络发送成功或模型已接收。",
        "note info"));
      addPre(body, "发送前请求体", record.providerPayload.body);
    } else if (record.snapshot) {
      if (record.snapshot.truncated) {
        body.appendChild(el("div", "内容超出单条预算，快照已截断。", "note warn"));
      }
      var cols = el("div", undefined, "cols");
      addPre(cols, "扩展收到的内容", record.snapshot.before);
      addPre(cols, "扩展输出的内容", record.snapshot.after);
      body.appendChild(cols);
    } else if (record.source === "provider_request") {
      body.appendChild(el("div", "该记录没有请求体内容（写入时未保存原文）。", "note warn"));
    } else {
      body.appendChild(el("div", "该记录未保存原文：只能查看命中元数据。", "note info"));
    }

    if (record.hits && record.hits.length > 0) {
      body.appendChild(el("div", "命中明细", "section-title"));
      body.appendChild(hitsTable(record.hits));
    }
    if (record.comparisons && record.comparisons.length > 0) {
      body.appendChild(el("div", "字段级对照", "section-title"));
      body.appendChild(comparisonsTable(record.comparisons));
    }

    wrapToggle.checked = true;
    document.body.classList.remove("nowrap");
    wrapToggle.addEventListener("change", function () {
      document.body.classList.toggle("nowrap", !wrapToggle.checked);
    });
    find.value = "";
    find.addEventListener("input", function () {
      applyFind(find.value);
    });
    copy.addEventListener("click", function () {
      copyDetail(copy);
    });
  }

  function applyFind(query) {
    var pres = document.querySelectorAll("#detail pre");
    var total = 0;
    for (var i = 0; i < pres.length; i += 1) {
      var pre = pres[i];
      var raw = pre.getAttribute("data-raw") || "";
      pre.textContent = "";
      if (!query) {
        pre.textContent = raw;
        continue;
      }
      var lower = raw.toLowerCase();
      var needle = query.toLowerCase();
      var at = 0;
      var hit = lower.indexOf(needle, at);
      while (hit !== -1) {
        if (hit > at) pre.appendChild(document.createTextNode(raw.slice(at, hit)));
        pre.appendChild(el("mark", raw.slice(hit, hit + query.length)));
        total += 1;
        at = hit + query.length;
        hit = lower.indexOf(needle, at);
      }
      if (at < raw.length) pre.appendChild(document.createTextNode(raw.slice(at)));
    }
    document.getElementById("findCount").textContent = total + " 处";
  }

  function copyDetail(button) {
    var pres = document.querySelectorAll("#detail pre");
    var parts = [];
    for (var i = 0; i < pres.length; i += 1) parts.push(pres[i].getAttribute("data-raw") || "");
    var text = parts.join("\\n\\n");
    function failed() {
      button.textContent = "复制失败";
      setTimeout(function () { button.textContent = "复制内容"; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = "已复制";
        setTimeout(function () { button.textContent = "复制内容"; }, 1500);
      }, failed);
      return;
    }
    failed();
  }

  function clear(kind) {
    var sessionId = document.getElementById("fSession").value;
    if (kind !== "all" && sessionId === "") {
      window.alert("请先选择一个会话，再清理该会话的记录。");
      return;
    }
    var scope = kind === "all" ? "all" : "session";
    var label = scope === "all" ? "全部记录" : "会话 " + sessionId + " 的记录";
    if (!window.confirm("确认删除" + label + "？该操作不可撤销。")) return;
    api("/api/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: scope, sessionId: sessionId, confirm: true })
    }).then(function (data) {
      window.alert("已删除 " + (data.deleted || 0) + " 条记录");
      offset = 0;
      selectedId = "";
      detailToken += 1;
      renderMessage("info", "选择左侧记录查看内容");
      return refresh();
    });
  }

  function refresh() {
    return Promise.all([loadStatus(), loadSessions(), loadRecords()]).catch(function (error) {
      renderMessage("bad", "加载失败：" + error.message);
    });
  }

  document.getElementById("reload").addEventListener("click", function () { refresh(); });
  function refilter() {
    offset = 0;
    selectedId = "";
    detailToken += 1;
    renderMessage("info", "选择左侧记录查看内容");
    loadRecords();
  }
  document.getElementById("fSession").addEventListener("change", refilter);
  document.getElementById("fSource").addEventListener("change", refilter);
  document.getElementById("fStatus").addEventListener("change", refilter);
  document.getElementById("fType").addEventListener("change", refilter);
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
