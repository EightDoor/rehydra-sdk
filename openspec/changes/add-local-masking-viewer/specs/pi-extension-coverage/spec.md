# Spec Delta

## MODIFIED Requirements

### Requirement: masking failure is reported without blocking the request

单次脱敏失败时，扩展 SHALL 保留该内容的原有形态继续处理本次请求，并 SHALL 记录一条可定位的告警；告警 MUST NOT 包含被脱敏的正文。失败的事实 SHALL 同时体现在脱敏记录中，使查看者能识别该次请求未被脱敏。

#### Scenario: failure keeps request alive and logs

- **WHEN** 脱敏过程中发生异常
- **THEN** 该次请求照常发出，不抛出异常终止扩展处理
- **AND** 产生一条标明失败位置的告警日志，且日志不含原文正文

#### Scenario: failure does not leak content into the log

- **WHEN** 脱敏失败并记录告警
- **THEN** 告警内容中不出现原始 PII 值

#### Scenario: failure is visible in the masking record

- **WHEN** 脱敏失败并放行该次请求
- **THEN** 产生一条带失败标记的记录，保存该次请求的实际输入与输出

## ADDED Requirements

### Requirement: extension exposes a local record viewer at startup

扩展 SHALL 在会话启动后提供本机访问的脱敏记录查看入口，并 SHALL NOT 再注册用于查看记录的命令行入口。

#### Scenario: viewer address is reported at startup

- **WHEN** 会话启动且查看页面启用
- **THEN** 用户收到该页面的本机访问地址

#### Scenario: no record command is registered

- **WHEN** 扩展完成注册
- **THEN** 没有用于查看脱敏记录的命令行入口

#### Scenario: viewer failure does not block the session

- **WHEN** 查看页面启动失败
- **THEN** 扩展照常工作，只输出一条不含原文的告警
