# Tasks

## 1. 记录层

- [x] 1.1 `src/records/types.ts` 增加来源 `provider_request`、范围 `provider-payload` 与请求体字段
- [x] 1.2 `src/records/snapshot.ts` 补充供应商内嵌图片省略规则，新增请求体组装与截断

## 2. 采集

- [x] 2.1 `src/pi-extension/host-types.ts` 声明 `before_provider_request` 事件与注册重载
- [x] 2.2 `src/pi-extension/extension.ts` 注册钩子，仅观察不改写，遵循记录开关与原文保存开关

## 3. 页面

- [x] 3.1 重写 `src/records/viewer/page.ts`：浅色工作台布局、列表 + 固定详情、默认选中
- [x] 3.2 上下文记录展示脱敏前后对照、命中明细与字段级对照
- [x] 3.3 请求体记录展示发送前请求体及采集边界说明
- [x] 3.4 内容工具（换行、查找、复制）与加载/空/错误/截断状态

## 4. 验证

- [x] 4.1 快照测试：图片省略、请求体截断标记
- [x] 4.2 扩展测试：钩子注册、请求体落盘、关闭原文保存不落正文
- [x] 4.3 页面/服务测试：请求体详情可读、来源可筛选、访问控制不回归
- [x] 4.4 运行 `npx tsc --noEmit`、`npm run lint`、`npx vitest run`
