# Spec Delta

## Purpose

提供启动即可访问的本机网页，让用户直接查看脱敏记录：扩展收到的完整内容与扩展输出的完整内容并排对照、命中明细、以及这次脱敏是否可靠。

## ADDED Requirements

### Requirement: viewer is reachable at startup

扩展 SHALL 在会话启动后提供本机查看地址，并只监听回环地址；扩展 SHALL NOT 要求登录凭证，也 SHALL NOT 自动打开浏览器。

#### Scenario: address is reported on startup

- **WHEN** 会话启动且查看页面启用
- **THEN** 用户收到形如 `http://127.0.0.1:<port>/` 的访问地址

#### Scenario: non interactive run reports on stderr

- **WHEN** 扩展在无界面的运行方式下启动
- **THEN** 访问地址输出到标准错误，不污染标准输出

#### Scenario: viewer failure does not break masking

- **WHEN** 查看服务启动失败
- **THEN** 脱敏与请求照常进行，只输出一条不含原文的告警

### Requirement: viewer serves the records for comparison

页面 SHALL 展示记录列表、会话/来源/类型/状态筛选、分页，以及单条记录的完整前后对照与命中明细。

#### Scenario: list and filter

- **WHEN** 用户打开页面
- **THEN** 页面列出记录并可按会话、来源、类型与状态筛选，列表可分页

#### Scenario: side by side comparison

- **WHEN** 用户打开一条记录
- **THEN** 页面并排展示扩展收到的内容与扩展输出的内容

#### Scenario: hit details are shown

- **WHEN** 记录包含命中
- **THEN** 页面列出命中类型、发现方式、检测器、占位符与原值

#### Scenario: failed or degraded requests are marked

- **WHEN** 记录带失败标记或降级标记
- **THEN** 页面明确标出该记录的处理状态

#### Scenario: the page claims only what it knows

- **WHEN** 页面展示一条记录
- **THEN** 页面只声称展示本扩展的输入与输出，不声称是供应商实际收到的报文

### Requirement: viewer is restricted to local same-origin access

查看页面 SHALL 拒绝跨站访问：校验请求 Host、拒绝跨站来源、拒绝 CORS 预检，数据与清理接口 SHALL 要求同源自定义请求头。

#### Scenario: cross-site read is rejected

- **WHEN** 来自其他站点的请求读取记录接口
- **THEN** 请求被拒绝，返回 403

#### Scenario: foreign host is rejected

- **WHEN** 请求的 Host 指向其它主机
- **THEN** 请求被拒绝，返回 403

#### Scenario: preflight is rejected

- **WHEN** 收到 CORS 预检请求
- **THEN** 请求被拒绝，不返回任何允许跨域的响应头

### Requirement: viewer renders original text safely

页面 SHALL 把原文与脱敏结果按纯文本渲染，MUST NOT 把其中的标记当作 HTML 执行，也 MUST NOT 加载外部资源。

#### Scenario: markup in original text stays inert

- **WHEN** 原文包含 HTML 标记
- **THEN** 页面只显示该标记的文本，不执行也不渲染它

#### Scenario: no external resources

- **WHEN** 页面加载
- **THEN** 不发起任何外部请求，响应带内容安全策略与禁止缓存头

### Requirement: clearing from the viewer needs confirmation

页面 SHALL 提供清理当前会话与清理全部两个操作，两者都要求用户在页面上确认；未确认时 SHALL NOT 删除任何记录。

#### Scenario: unconfirmed clear keeps records

- **WHEN** 用户发起清理但没有确认
- **THEN** 不删除任何记录

#### Scenario: confirmed clear deletes records

- **WHEN** 用户确认清理
- **THEN** 对应范围的记录被删除
