# Spec Delta

## Purpose

规定 `pi-rehydra` 发布包的产物完整性契约：哪些文件必须出现在 tarball 中、打包前必须完成哪些准备步骤，以及产物不完整时必须以失败结束。

## ADDED Requirements

### Requirement: packaging syncs the build output first

任何生成发布包的路径 SHALL 在打包前把 SDK 构建产物同步到包的 `dist/` 目录。

#### Scenario: dist is present without manual steps

- **WHEN** 在包目录执行 `npm pack`，且此前 `dist/` 不存在
- **THEN** 打包过程先生成 `dist/`
- **AND** 打出的 tarball 中包含 `dist/` 下的实现文件

#### Scenario: publish follows the same preparation

- **WHEN** 执行发布流程
- **THEN** 使用与 `npm pack` 相同的准备步骤，不依赖手工先跑同步

### Requirement: incomplete packages fail loudly

发布包缺少加载入口所依赖的文件时，打包预检 SHALL 以非零退出码结束，并 SHALL 列出缺失的文件名。

#### Scenario: missing dist is reported

- **WHEN** `dist/` 未同步而执行预检
- **THEN** 预检以非零码退出
- **AND** 输出明确指出缺失的 `dist` 内文件

#### Scenario: complete package passes

- **WHEN** `dist/` 已同步且产物完整
- **THEN** 预检通过并报告已校验的文件数量

### Requirement: verification reads the real package listing

预检 SHALL 依据实际打包清单判断完整性，MUST NOT 只依据 `files` 字段或忽略规则自行推断。

#### Scenario: listing comes from the packer

- **WHEN** 执行预检
- **THEN** 判定依据是打包工具实际输出的文件清单
