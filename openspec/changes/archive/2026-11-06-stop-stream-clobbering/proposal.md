# Proposal

## Why

流式脱敏在 `createStream()` 时把当时的映射快照种进缓冲区，结束或定时保存时用
`getCumulativePiiMap()` **整体覆盖**写盘。若期间有普通脱敏向同一会话写入了新条目，
这些条目会被流的旧快照删掉，已经发出去的占位符再也还原不回来。

上一轮把流式保存排进会话队列后，这个覆盖顺序从"竞态"变成"确定发生"，因此必须修。

## What Changes

- 流式保存（定时保存与结束保存）改为先读取存储里的最新映射，与自身快照合并后再写盘；已存在的键不被覆盖。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `session-map-caching`：补强"流式写盘不得删除已落盘条目"。

## Impact

- 修改 `src/streaming/anonymizer-stream.ts`（两处保存合并为一个 `saveMergedToStorage`）。
- 每次流式保存多一次 `load` + 解密；保存本身已是低频路径（节流或结束时一次）。
- 已知限制：流与普通脱敏同时为同一类型分配新 ID 时仍会撞号，本例保留流侧的值。
