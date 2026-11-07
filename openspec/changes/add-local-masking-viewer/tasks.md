# Tasks

## 1. 记录层

- [x] 1.1 在 `src/records/types.ts` 给记录加上完整文本快照与失败标记字段
- [x] 1.2 新增 `src/records/snapshot.ts`：快照序列化、二进制载荷剔除、按字节截断
- [x] 1.3 新增 `src/records/sqlite-store.ts`：建表、写入、分页查询、筛选、清理、保留裁剪、权限收紧
- [x] 1.4 删除 `src/records/recorder.ts`（JSONL 写入器）

## 2. 查看页面

- [x] 2.1 新增 `src/records/viewer/page.ts`：内联静态页面，列表、筛选、详情、前后对照
- [x] 2.2 新增 `src/records/viewer/server.ts`：只监听回环地址，Host/Origin/预检校验，状态/列表/详情/清理接口
- [x] 2.3 原文只按纯文本渲染；响应带 CSP、`no-store`、`nosniff`

## 3. 扩展接线

- [x] 3.1 扩展改用 SQLite 存储，`context_with_system` 与 `tool_result` 采集完整前后快照
- [x] 3.2 脱敏失败时记录实际输入与输出并打上失败标记
- [x] 3.3 移除 `/rehydra` 命令及其查看与清理实现
- [x] 3.4 会话启动时启动查看页面并展示访问地址（无界面时写 stderr），退出时关闭

## 4. 配置与文档

- [x] 4.1 记录默认开启且默认保存原文；新增 `dashboard.enabled`
- [x] 4.2 更新 `src/pi-extension/options.ts` 与 `src/host-agnostic/normalize-options.ts`
- [x] 4.3 更新根 README（中英）与 `packages/pi-extension/README.md`（中英）

## 5. 验证

- [x] 5.1 存储测试：落盘、查询、筛选、分页、清理、权限、裁剪、状态派生
- [x] 5.2 页面测试：访问控制、只读接口、清理确认、页面渲染
- [x] 5.3 扩展测试：快照落库、关闭原文时不落快照、失败标记、命令已移除
- [x] 5.4 运行 `npx tsc --noEmit`、`npm run lint`、`npx vitest run`
