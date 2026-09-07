# 观察模型、执行对照与迁移 AGE分析

本次更新保留 paper_spot_v1 账面收益，新增 execution_comparison v1，将现有 shadow 的延迟成交、恒定乘积冲击、费用和滑点假设显式输出为入场成本、退出到账估计、净 SOL 收益，并通过 key 与实际 paper 记录配对。原始 outcome 标签定义不变，旧模型和旧训练数据仍可按原 policyId 使用；新的对照规则另有 experimentId，不混淆版本。它是可观察行情下的估计，不能替代真实成交。

默认候选对照规则：砸单小于 40 SOL；触发前至少连续三笔卖出且 15 秒卖出 SOL 大于买入 SOL 两倍时排除；记录到该币实际 paper 亏损或实盘确认亏损后 10 分钟内排除；另记录三者组合。它们仅产生日志，不改变引擎买卖。连续卖压只使用触发前历史，不能看到未来同 slot 砸单后追溯拒绝原买入。重启/断流后亏损历史不完整，冷却实验先记未知，完整等待冷却窗口后才允许记通过；旧记录不回填新规则。

这些是候选筛选对照，未独立重演各策略钱包容量、资金占用和冷却状态；累计 proxy 收益不能当作各策略真实账户收益。quality.json.executionComparisons 会区分规则通过、排除、未知及观察删失；paperProxyPairs 只比较可关联且有结果的子集，两个口径的入场/退出时间可能不同。

## AGE：毕业迁移后的时间

AGE 唯一定义是自 Pump 毕业迁移到 PumpSwap 起经过的时间，不是代币创建时间，也不是普通池创建时间。

程序核对 Pump 官方 CompletePumpAmmMigrationEvent 与同笔 migrate 指令中的 mint、pool、PumpSwap 程序及 WSOL 账户，记录 migrationAt 和候选时 migrationAgeMs。来源定义：[Pump 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json)。既有 Helius PumpSwap 交易流中包含目标程序的迁移交易可被识别，不增加 RPC，不新增订阅。

事件来自 processed 行情，尚未 finalized 核验，明确标记 observed_processed_not_finalized。普通 CreatePoolEvent 不计作毕业迁移。没有采到迁移事件、证据冲突或时间异常时年龄为 null；不以程序首次观察时间代替，也不自动发请求回查老币。缓存 migration-age-cache.json 最多 20,000 池，工作线程每分钟及正常退出时保存；异常退出可能丢失最近一分钟缓存。旧数据没有这些字段，不能补造。

quality.json 的 audit.migrationAge 按策略和迁移年龄分组：未知、0–5分、5–15分、15–30分、30–60分、1–4小时、4小时以上。分别统计候选、60秒可观察结果、反弹正标签与至少50% proxy 回撤；严重回撤不等于已确认 RUG。AGE 暂不加入旧模型特征向量、不拦截买单，避免破坏模型兼容性。代币创建时间明确留空。

## 模型只观察部署

先更新服务器代码。在服务器放好此前下载的 strategy_proxy.experimental-model.json，然后在项目根目录执行：

```bash
node helius/scripts/prepare-observation-model.js /绝对路径/strategy_proxy.experimental-model.json
```

脚本检查验证结果和当前策略指纹，将文件复制到 helius/data/models/ 唯一文件，并把独立观察起点设为准备时刻及已有截止时间的较晚者。输出 SHADOW_MODEL_FILE 配置；将这行写入 helius/.env，随后：

```bash
sudo systemctl restart dump-sniper
sudo journalctl -u dump-sniper -n 30 --no-pager
```

观察线程会记录模型状态与预测；失败、配置不匹配或无历史时概率为空。该脚本不替你修改 .env、不启动实盘，不删除已有模型。模型仅在进程启动时加载，因此本次引擎/线程修改需要一次重启，和此前仅更新导出脚本不同。重启后 paper 持仓按已有状态恢复，短时历史重新积累。服务器配置和模型文件尚未由本地助手部署。

## 止损诊断

paper_sell、sell_submitted、确认记录增加诊断：首次触发时间、原因与价格、上一价格时间、行情事件时间/接收时间、处理时间、slot、受钱包锁等阻塞次数，以及执行/提交耗时。stream 和确认 RPC 轮询分开标记；事件时间精度不是微秒级测量。首次触发保留到卖出用于定位等待，最终卖出原因可能不同。paper 卖出记录仍是即时账面模拟，不能当作实盘测速。

## 性能与归档

模型、对照与年龄缓存都在原观察线程运行；新增数据复用行情，不增加 Helius 请求。买入路径不等待模型、年龄查询或实验结果。每个策略目标多一条 comparison 日志，增加本地磁盘和归档体积；年龄缓存写盘也共享机器资源。日报及小时归档自动包含这些记录，不需要改变 COS 定时器。75 项本地测试通过，包括迁移事件及指令联合认证、未知年龄、时序隔离、观察缺失、对照版本、钱包阻塞诊断及归档分组。

## 2026-09-08：迁移诊断与执行差额拆分

迁移解析同时支持 CPI 事件和带完整运行调用栈的 Program data 事件；只接受成功的 Pump 调用帧，并再次核对 migrate 指令、代币、目标池和 WSOL。嵌套其他程序伪造数据、失败/截断调用帧、仅有事件没有匹配指令都不接受。同笔 CPI 与日志重复事件去重。只修复已知的解析覆盖缺口，不声称已用服务器真实迁移证明 AGE 恢复。

quality.json 的 audit.migrationPipeline 包含最新的进程累计计数与记录时间：parser 为 Pump交易、迁移指令、CPI/日志完成事件、解码失败、账户不符和匹配成功；worker 为收到/恢复/拒绝/淘汰的迁移证据、缓存池数及候选已知/未知年龄；cacheStatus 区分缺失、载入、读写失败。不同进程计数会重置，不能直接将不同快照相加。候选 unknownReason 区分未缓存、证据冲突、币不符和证据时间晚于候选。主进程每次启动最多保留20条迁移诊断样本，仅包含计数、签名和日志可用性，不保存原始交易或密钥。

短窗口检查路径：

- parser 无迁移指令：该窗口没有识别到支持的迁移指令，需要核对订阅可见性/当前指令版本，不能仅凭零值断言没有新币。
- 有指令、没有匹配完成事件：查看 CPI/日志计数、解码/账户匹配错误和诊断签名。
- parser 匹配成功，worker 未接收：检查观察线程状态、队列丢弃和缓存拒绝计数。
- worker 缓存有值，候选 AGE 仍全未知：核对池/币匹配、是否确实交易了这些新迁移池；旧币没有历史补查仍应未知。
- cacheStatus 为读写失败：检查目录权限和磁盘。年龄缓存写失败不会单独使观察线程退出。

新归档增加 execution-audit.json：按 paper 平仓关联 proxy，区分没有对照、观察删失、旧记录缺拆分、已核平和拆分不符。新数据保存入场现价数量、恒定乘积报价、扣费后数量、滑点与取整后数量，以及退出各报价阶段。差额分为入场冲击、入场费用影响、入场滑点取整、退出冲击/费用/滑点、双边网络费用和剩余的时间/退出规则项。带符号拆分须与 proxy 净收益减 paper 毛收益核对，容差1e-8 SOL；这是一条核算等式，不是严格因果归因，时间项也可能包含头寸差异，费用均为模型假设。

旧归档只能核对最终收益和可用时间，不能反推出缺少的报价过程。单独审计命令：

```bash
node helius/scripts/audit-execution.js /归档目录
```

日报和即时导出均自动生成此文件；COS上传四个文件全部校验后推进游标。旧日报已上传的游标不会因此自动回退重传。增加本地扫描和磁盘开销，但不增加 Helius 请求，交易不等待归档。

服务器更新代码后重启交易服务一次，再执行 `node helius/scripts/export-recent.js --hours 0.25` 导出最近15分钟。检查 quality.json 的 migrationPipeline 与 execution-audit.json；如果15分钟内没有可核验的新迁移，不能宣称AGE已验证，继续观察或根据诊断签名核对真实交易。固定止盈20%、止损25%、单笔1 SOL等阈值保持原配置。
