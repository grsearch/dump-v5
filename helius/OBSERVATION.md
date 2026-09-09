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

模型、基于交易流的对照与年龄缓存都在原观察线程运行，复用行情。账户状态补报价另有请求预算，见 exitResearchVersion=2 章节。买入路径不等待模型、年龄查询或实验结果。每个策略目标多一条 comparison 日志，增加本地磁盘和归档体积；年龄缓存写盘也共享机器资源。日报及小时归档自动包含这些记录，不需要改变 COS 定时器。99 项本地测试通过，包括迁移事件及指令联合认证、未知年龄、时序隔离、观察缺失、对照版本、钱包阻塞诊断及归档分组。

## 2026-09-08：迁移诊断与执行差额拆分

迁移解析同时支持 CPI 事件和带完整运行调用栈的 Program data 事件；只接受成功的 Pump 调用帧，并再次核对 migrate 指令、代币、目标池和 WSOL。嵌套其他程序伪造数据、失败/截断调用帧、仅有事件没有匹配指令都不接受。同笔 CPI 与日志重复事件去重。只修复已知的解析覆盖缺口，不声称已用服务器真实迁移证明 AGE 恢复。

quality.json 的 audit.migrationPipeline 包含最新的进程累计计数与记录时间：parser 为 Pump交易、迁移指令、CPI/日志完成事件、解码失败、账户不符和匹配成功；worker 为收到/恢复/拒绝/淘汰的迁移证据、缓存池数及候选已知/未知年龄；cacheStatus 区分缺失、载入、读写失败。不同进程计数会重置，不能直接将不同快照相加。候选 unknownReason 区分未缓存、证据冲突、币不符和证据时间晚于候选。主进程每次启动最多保留20条迁移诊断样本，包含计数、签名、日志可用性及账户不符时的逐字段比较，不保存原始交易或密钥。

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
# AGE 历史交易取证（2026-09-08）

AGE 仍定义为 Pump 毕业迁移完成后的时间，不是代币创建时间。解析器支持官方 `migrate` 和 `migrate_v2`，均要求迁移指令与完成事件的 mint、pool、PumpSwap 程序和 SOL 报价账户一致。非 SOL 迁移不进入 AGE 缓存。

账户校验失败的 `migration_diagnostic` 现在包含事件字段、事件长度、传输方式和逐项比较结果；保留原有每进程最多 20 条签名诊断的限制。不增加常驻 RPC 请求。

在服务器的 `helius` 目录运行（不必停止服务）：

```sh
node scripts/diagnose-migration.js
```

默认读取本机 `.env` 的 Helius RPC，逐笔查询 2026-09-08 01:03 和 01:06 两笔已知失败签名，共两次 `getTransaction`，每次最多 20 秒，不自动重试。也可在命令后提供 1–3 个签名。输出路径显示在终端，文件为 `data/migration-diagnosis-*.json`。将该文件下载用于排查；它包含公开的 Pump 指令账户与指令数据，不包含 RPC URL 或密钥。请求失败会写入状态并返回非零退出码。

该工具只取证，不写 AGE 缓存，不回填旧训练样本。历史交易的当前查询结果也不能伪装成当时已经知道的信息。单元测试验证了格式和严格匹配；两笔真实交易的具体不匹配原因仍需服务器取证文件确认。官方格式来源：https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
# 2026-09-08：风险、收益训练及退出观察对照

本次不更改买卖参数，不让模型决定订单。模型评分与基于交易流的对照在观察线程运行，复用已有行情；账户状态补报价另有请求预算。程序仍不自主训练或替换模型。

## 新训练目标

- `loss_25`：现有策略完成退出后，净损失达到入场成本的 25% 或以上的概率。不是 RUG 判定，也不是持有期间最大回撤概率。
- `net_return`：净收益 / 入场成本的回归估计。输出 `expectedNetReturn`（例如 0.02 表示 2%），不是 SOL 金额，不放入 probability 字段。
- 两者仅使用已观察的 `strategy_proxy`、有限的 `netPnlSol` 和正数 `entryCostSol`。旧记录缺金额、删失或未完成时不造标签。因此有效样本可能少于原有二分类目标。

仍按时间 60/20/20 切分、剔除跨区间标签。校准段和测试段均调用与运行时相同的 8 标准差过滤；拒绝数量写入 coverage，过滤后不足 100 条则不产出有效模型。分类还要求每类至少 20 条。测试和常数基线比较使用相同可评分子集。训练器不会按测试集收益寻找最优阈值。

净收益回归为标准化特征的正则线性回归，仅用训练段拟合、校准段校正偏差。测试 MSE 小于同子集基线仅表示实验统计门槛通过，不是盈利验证。报告同时列出固定阈值下的已知净收益与未知数量；单独反弹数据缺少金额时保留未知，不能将报告的空合计解读为保本。

在 helius 目录离线执行：

```sh
node scripts/train-shadow.js --data data/shadow --target loss_25 --out data/models/loss-25.json
node scripts/train-shadow.js --data data/shadow --target net_return --out data/models/net-return.json
```

多策略归档应显式添加 `--policy HASH`。训练输入是 `samples-*.jsonl`，不是压缩归档路径；先提取并按来源保留样本/标签、去重。训练耗 CPU，应在分析机器运行，避免挤占交易服务器资源。报告为输出模型路径加 `.report.json`；验证失败的模型会被运行时拒绝；样本不足时会清除同一输出路径上的旧模型，以免误用。

需要观察时，先用 `node scripts/prepare-observation-model.js MODEL.json` 检查配置和验证结果，并把输出的 setting 写入服务器 .env：

```dotenv
# 以下是可选模型路径；发行包不包含训练模型。
# SHADOW_RISK_MODEL_FILE=data/models/loss-25.json
# SHADOW_RETURN_MODEL_FILE=data/models/net-return.json
SHADOW_EXIT_COMPARISONS=true
```

准备工具会将观察起点设为准备时刻和模型已用标签截止时间的较晚者。模型不热更新，需正常重启服务读取配置；模型无效、目标错误、历史不足或分布外时不给评分。sample / execution_comparison 新增 `objectivePredictions.loss25`、`objectivePredictions.netReturn`；shadow_health 提供两个模型状态。未配置时如实显示 no_model。

## 原四组固定退出对照（新增30%/50%组见文末）

所有对照共享原策略的模拟入场金额、时间与成本：

1. `exit_250ms`：原退出触发逻辑，等待至少 250ms 后的第一条可见行情估算退出。
2. `exit_1000ms`：原退出触发逻辑，等待至少 1000ms。
3. `net_take5`：估计净收益达到 5% 时增加提前止盈触发，退出延迟沿用 SHADOW_EXIT_DELAY_MS；保留原止损、追踪和超时退出逻辑。
4. `no_fixed_stop`：仅禁用固定价格止损，保留原止盈、追踪和 maxHoldMs（默认30分钟），沿用原退出延迟与成本。独立于 paper/live 订单执行，原止损参数不变。

新对照对所有已模拟入场候选采集，后续按候选买前特征或事先冻结的反弹评分分组；不能按未来是否反弹挑选样本。记录 entryCostSol、minNetPct/maxNetPct（观察持有期间相对入场成本的最低/最高净收益，非峰谷最大回撤）、firstFixedStopAt（首次触及原价格止损线）。评估时按同一候选配对原策略，统计原止损后改善/恶化、最终收益、深亏、持仓时间及缺失比例；未卖出、断流、不可报价不算回本。

这条新方案可能延长观察并占用采集容量，尤其是不再止损后长期无反弹的样本。最长持仓只触发退出意图，须等待延迟后的可见报价；缺报价仍为删失，不能把最后价格当作强制成交。不会补出旧版本已经停止采集的后续走势。

触发时价格不能当成交价，没有及时可见行情则删失。对照属于 `exit_comparison` 独立记录，不改 strategy_proxy 的定义或 policyId。quality.json 的 `audit.exitComparisons` 按策略、版本、方案聚合已完成记录，并提供与同一候选原策略配对的差额；尚未完成的方案不在完成合计内。不能比较不同样本集合的总额后声称收益改善。

对照可能延长观察至原 maxHoldMs，在现有 active/每池上限内运行；增加观察线程计算、日志和归档量，可能影响观察容量。关注 active、censored、queueDepth、dropped。可设 SHADOW_EXIT_COMPARISONS=false 关闭；不会改变真实交易参数。每日 COS 归档自动包含这些记录，无需调整 7 点定时器。

## 本次验证与实际数据试训

99 项测试通过，覆盖运行时一致过滤、收益单位、缺失金额拒绝、未来时间隔离、退出延迟、缺失对照、原标签不变及归档配对。本机 6400 条合成事件主线程入队 p95 约 0.0025ms，0 丢弃；不包含网络和观察线程计算，不能作为买入延迟承诺。

9 月 8 日 7 点归档试训：两个新目标各 1273 条有效记录。loss_25 测试 Brier 0.18894 / 常数基线 0.19184；net_return 测试 MSE 0.05809 / 基线 0.05878，MAE 反而较差（0.20150 / 0.19343）。改进很小，且固定正收益预测筛选的 25 条已知结果仍为 -0.4305 SOL，不证明可盈利。私人数据、报告、模型保留本地，不进入发行包或 GitHub。
# AGE 原生 SOL 报价兼容修复

Pump 官方 COIN_CREATION.md 说明：SOL 报价的 bonding_curve.quote_mint 使用 Pubkey::default()；指令账户仍使用 WSOL。2026-09-08 08:09 更新后的真实迁移诊断中，存在币、池、AMM、WSOL 指令账户全部匹配，但事件 quote_mint 为默认公钥的记录。解析器现接受该事件表示，同时仍要求同一迁移指令的报价账户严格为 WSOL，其余匹配条件不变。USDC 等报价仍拒绝。

新增累计计数 migration_native_sol_quote_matched。更新后应检查该计数或 migration_matched 增长、worker accepted/cachedPools 增长；只有随后涉及已缓存池的候选才会出现已知 AGE。不会将老样本 unknown 改成已知，也不会用代币创建时间或首次看到时间替代毕业迁移时间。

官方依据：https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md 。默认公钥在事件中的兼容依据还包括用户提供的真实诊断；测试覆盖 migrate/migrate_v2、默认事件报价、显式 WSOL、旧事件缺字段、账户不符和非 SOL 拒绝。服务器实际恢复需更新后观察新迁移确认。
# 固定组合筛选与自动验证报告

新增 selection-v1 观察版本：每个候选产生固定的 baseline、market、risk、net、combined 五组结果。baseline 检查信号新鲜度；market 再检查现有卖单上限和持续卖压；risk 要求 loss_25 概率 <0.25；net 要求预期净收益率 >0；combined 同时满足全部条件。这些是预先固定的研究阈值，不代表已优化参数，不控制 paper 或真实订单，也不增加 RPC。

`sample.selection` 和 `execution_comparison.selection` 保存筛选版本哈希、规则、市场过滤版本、风险与收益模型 ID、逐项检查和拒绝/未知原因。模型未加载、目标不符、分布外或历史不足时不将模型项标为通过。组合已有明确失败项时为 reject，其余缺失项仍保留在 unknown 列表；没有失败项但有缺失则为 unknown。

本次不自动安装或启用训练模型。服务器仍需按上面的准备模型流程分别配置 SHADOW_RISK_MODEL_FILE / SHADOW_RETURN_MODEL_FILE 并重启。未配置时市场对照可运行，模型组合会如实记录未知。

每日 COS 和手动导出的 `quality.json` 自动新增 `audit.selectionValidation`。无需更改上传定时器或文件清单。按以下字段隔离：runId、runStartedAt、observationVersion、policyId、selectionId、marketExperimentId 和 modelIds。runStartedAt 是本次观察进程启动时刻，不等于 Git 部署版本证明。

每组提供通过、拒绝、未知决策、已知收益、删失、待完成、大亏比例、胜率、每候选净收益和北京时间分小时统计。大亏定义为已知最终净损失占入场成本至少 25%。旧记录没有 selection 时计入 legacySamples，不按新规则事后补造选择结果。候选按归档时间窗归属；更新前上下文不混入新窗口。同一进程重复 chain key 去重，冲突样本剔除。

配对字段 baselinePairedSol / filteredPairedSol 仅使用决策已知且策略收益已知的同一批候选：通过者保留原收益，拒绝者作为未下单、收益为零；pairedDifferenceSol 为两者差额。此处是固定过滤的候选级反事实对照，不模拟资金、并发持仓、后续信号变化或实际成交。必须同时看 meanSelectedNetSol、selectedMissingRate 和 severeLossRate，不能仅以少交易后的总亏损减少认定有效。完全没有已知收益时 selectedNetSol 为 null。

报告不自动批准实盘，不在线搜索阈值、不改模型。完整测试覆盖缺模型未知、严格边界、版本分组、同候选配对、缺失结果、重复冲突和旧窗口隔离。

## 双评分跨时段观察（selection-v2）

新增训练目标 drawdown_60s_25：从完整 rebound_60s 结果的 minNetPct <= -25 派生；缺失、删失、观察不足60秒不填标签。该目标与 loss_25（策略最终平仓净亏损25%）不同。

训练命令：

~~~bash
node helius/scripts/train-shadow.js --data helius/data/shadow --target rebound_60s --out helius/data/models/rebound60.json
node helius/scripts/train-shadow.js --data helius/data/shadow --target drawdown_60s_25 --out helius/data/models/drawdown60.json
node helius/scripts/prepare-observation-model.js helius/data/models/rebound60.json
node helius/scripts/prepare-observation-model.js helius/data/models/drawdown60.json
~~~

准备工具验证策略口径、模型验证结果，并把观察起点移至准备时刻之后；按输出分别设置 SHADOW_MODEL_FILE 与 SHADOW_DRAWDOWN_MODEL_FILE。模型可用后重启才加载。模型属于私有运行文件，不进入Git或公共发行包；只更新代码不能自动得到训练好的评分。旧模型不匹配、缺失或超训练范围时明确unknown，不允许按低风险放行。

固定观察组 joint：新鲜候选、rebound_60s概率>=0.60且drawdown_60s_25概率<0.25。highRebound：新鲜候选、rebound_60s概率>=0.80，用于检查高反弹组的无固定止损对照。不叠加旧combined组的金额/流量/净收益限制；各组定义独立，避免混淆实验。所有筛选仅写盘，不改变引擎下单、仓位或买卖阈值。

sample / execution_comparison 记录 objectivePredictions.drawdown60；原prediction提供反弹评分。selection.version=2、observationVersion=selection-v2，记录两模型ID和固定规则。exit_comparison带买前selection，不能用事后涨跌挑样本。shadow_health.drawdownModel与session.drawdownModelStatus可核查是否已加载。

quality.json 的 audit.selectionValidation.groups 每组新增 reboundBySelection（完整60秒的反弹/大跌/两者都发生/未知），exitsBySelection（同候选原策略与退出对照的配对收益、差额、50%深亏、未配对数）。按运行、策略、规则及模型ID分组，兼容旧v1。无完整配对时金额为null，不把缺失结果当作0收益或回本。归档出口自动包含新字段，无需调整北京时间7点的定时任务。

## 间断后的独立长期观察（recoveryVersion=1）

开启SHADOW_EXIT_COMPARISONS时，已有模拟入场且no_fixed_stop尚未完成的样本，在池行情间隔、旧行情、无法报价、断流或队列覆盖中断时，可进入独立恢复观察。原strategy_proxy、反弹标签与exit_comparison仍按原规则删失，不改成成功；恢复记录为no_stop_recovery，coverage=discontinuous，不供原训练目标使用。

记录阶段started、first_quote、finished；后续可报价退出为discontinuous_proxy，到期仍无可报价退出、容量不足或停机为unknown，净收益为空。首次恢复报价可核对距间隔多久；minObservedNetPct/maxObservedNetPct仅是恢复后可见报价极值，不代表缺口内完整轨迹。保留缺口前已触发的退出意图，否则按后续可见报价触发止盈/追踪或按原入场时间触发最长持仓退出；无法知道缺口中是否曾触发条件，因此必须独立统计。

到原maxHoldMs（默认30分钟）后，最多再等exitDelayMs+maxGapMs（默认500ms+10秒）的真实报价；到期没有报价则结束为unknown，不能用旧价强平。恢复池独立使用SHADOW_MAX_ACTIVE及SHADOW_MAX_ACTIVE_PER_POOL容量上限，不挤掉原活动样本，但最多增加同规模的研究状态，可能增加工作线程内存、CPU及行情日志；不增加Helius请求。关注shadow_health.recovery的active、capacity、expired、completed。进程重启不恢复旧研究持仓，正常关闭明确记录unknown。

quality.json新增audit.noStopRecovery，按运行、策略、筛选及模型ID分别统计all/joint/highRebound的间断报价结果、未知以及同候选原策略配对金额。该汇总按恢复结束时间窗口统计，与按候选时间统计的selectionValidation不能混加，也不能与完整退出样本混作胜率。audit.modelPredictions报告模型缺失/历史不足/异常范围的数量；缺失模型时输出明确提示。COS归档增加第二模型及其他已配置观察模型快照。

## 一次安装两个模型并检查

先将私有模型包解压到服务器的一个目录，再在实际部署目录执行（以下使用绝对路径，按模型存放处修改）：

~~~bash
node /opt/dump-sniper/helius/scripts/install-observation-models.js /path/to/rebound60.json /path/to/drawdown60.json /opt/dump-sniper/helius/.env
node /opt/dump-sniper/helius/scripts/install-observation-models.js --check /opt/dump-sniper/helius/.env
sudo systemctl restart dump-sniper
~~~

安装前同时验证两个目标、策略口径、离线验证结果；验证失败不修改.env。成功后写入私有模型副本，观察起点移到安装时刻之后，备份.env并仅更新两项模型路径，去除它们的重复配置，不改金额、密钥、止盈止损。备份包含密钥，应只保留在服务器受限目录。检查非成功状态返回非零退出码。配置检查只能证明文件可加载；重启后还需在session中核对modelStatus及drawdownModelStatus都为experimental_calibrated_model、noStopRecoveryVersion=1。

## 提高止盈与账户状态补报价（exitResearchVersion=2）

本次不修改订单引擎、固定模型、1 SOL配置或原训练标签。固定止盈按价格涨幅触发，最终收益按原曲线冲击、费率、滑点及网络费假设估算，不把30%价格涨幅当作30%净利润。

新增四个连续观察对照：take30、take50、take30_no_stop、take50_no_stop。前两组保留原固定止损，后两组取消固定止损；所有组共享原模拟入场、保留原移动止盈和最长持仓。默认仍为涨幅10%启动移动止盈、从最高价回落3%退出，因此可能在达到30%/50%之前退出。原基准与no_fixed_stop提供默认20%的两组参照，其他250ms/1000ms/net_take5研究继续保留。仅新增本地研究状态，不发订单。

未知结果不代表没有流动性或必然归零。连续研究仍在超过SHADOW_MAX_OBSERVATION_GAP_MS（默认10秒）没有有效池子事件时删失；没有及时入场的样本不补造买入。新增两个独立分支：
- exit_recovery：对其他尚未完成的退出组以及尚未完成的基准，等待恢复后的真实交易事件；no_fixed_stop原有no_stop_recovery分支继续独立。
- state_exit_recovery：对所有尚未完成退出组和基准，独立使用Helius账户状态估价。它不会与交易事件恢复分支合并，也不会覆盖原outcome/exit_comparison。两分支可能涵盖同一个样本，金额不能相加。

所有恢复分支都保留coverage=discontinuous。缺口前已触发的退出意图保留；否则只根据缺口后的可见报价判断退出。缺口内是否曾触发止盈/移动止盈仍未知。账户估价结果status=account_state_proxy，恢复成交事件结果status=discontinuous_proxy，均不是实盘成交或连续价格路径。最长持仓后仅再等该组退出延迟加maxGapMs，超过期限、容量不足或停机仍为unknown，不用旧价强平，也不无限延长亏损观察。

配置（默认开启，无需手动新增到旧.env才生效）：

~~~dotenv
SHADOW_STATE_QUOTES=true
SHADOW_STATE_QUOTE_REQUESTS_PER_MINUTE=10
SHADOW_STATE_QUOTE_INTERVAL_MS=15000
~~~

SHADOW_EXIT_COMPARISONS=false或SHADOW_ENABLED=false时不会发起这类查询。SHADOW_STATE_QUOTES=false仅关闭账户状态研究，保留基于交易流的对照。恢复状态按每个分支的SHADOW_MAX_ACTIVE/SHADOW_MAX_ACTIVE_PER_POOL约束：原no_stop_recovery每样本一项，新增两分支按每个样本的每个退出组计一项；容量不足明确记录unknown。关注capacity，不能忽略被容量筛掉的样本。

后台查询不进入买入等待链路，不对全网池子轮询。只有已模拟入场且仍有账户恢复研究的池子会请求；同池不同样本和退出组共用一次快照。每批最多20池、80个账户，读取池子、base mint、两个金库，在同一confirmed上下文核对身份、代币程序、金库归属、冻结状态和储备；读取当前virtualQuoteReserves，不沿用中断前储备。带minContextSlot拒绝旧状态。不支持的扩展、无效账户、空储备明确返回不可估价，不能当作已确认无法卖出。

请求为独立异步服务，单并发，3秒超时；普通查询每池成功后间隔15秒，失败指数退避至最多120秒。schedulingVersion=2优先处理到期退出，允许新到期退出越过一次旧轮询等待，但仍遵守滚动分钟总预算，详见末尾说明。每分钟10次意味着满负荷最多14,400次/24小时；实际请求量取决于活跃恢复池，不能保证为零，也不是credits数量。健康日志rpcRequests包括这些请求；shadow_health.stateQuotes单独显示requests/queriedPools/quotedPools/failedPools/budgetSkips。账户研究只使用现有Helius RPC，不新增Birdeye或DEX Screener依赖。

轮询的实际退出延迟可能是数秒或更久，不能当成500ms成交。快照必须在退出等待期限之后发起才能用作退出估价。超过3秒的响应/工作队列交付、比已知流事件slot更旧的结果不会使用。记录state_quote中的requestAt、at、latencyMs、slot、原始储备、失败原因与discardReason；恢复记录带variant、assumptions、quoteSource、quoteSlot、quoteRequestAt、actualExitDelayMs、gapReason。SDK费率仍使用研究配置假设，快照估价不保证交易可执行。

每日COS模板自动包含新记录，无需改7点定时器。quality.json新增：
- audit.stateQuotes：取得报价、无法报价、原因及丢弃原因。
- audit.researchRecovery：按运行/策略/模型/退出组/来源分开统计all、joint、highRebound，含已取得估价、未知原因、待完成和与完整基准的同候选配对；另外用pairedWithSourceBaseline及sourceDifferenceSol记录同来源恢复基准的配对，两个配对口径不能混加。以窗口内最新恢复活动记录为口径，非候选窗口总量。
- audit.selectionValidation.exitsBySelection：增加四个止盈对照，仍只用连续、同候选、同策略的完整配对；pending和未知不填零。

原audit.noStopRecovery与连续audit.exitComparisons保持各自口径。研究分支不进入模型训练，不自动提高止盈、不取消真实止损。

更新后按现有部署步骤重启，保留.env/data及现有模型，无需重新安装模型。先导出15分钟窗口检查：
1. session.exitResearchVersion=2，stateQuoteVersion=1，exitVariants含take30/take50及其no_stop版本；双模型仍正常加载。
2. 发生行情缺口后出现state_quote与state_exit_recovery记录。短窗口没有缺口时零请求是正常的，不应为了验证而主动全网查询。
3. 核对shadow_health.stateQuotes请求量、失败原因、各恢复capacity/expired和quality.json独立分组；原交易金额和止盈止损配置保持不变。

### Token-2022补报价兼容修复（validationVersion=2）

账户状态补报价不再以mint必须82字节、金库必须165字节一刀切拒绝。对Token-2022逐项解析TLV，当前只放行mint的MetadataPointer、TokenMetadata及金库的ImmutableOwner；它们分别用于元数据信息、固定账户所有者，不改变本研究按原始数量计算的曲线金额。依据：[Solana元数据扩展](https://solana.com/docs/tokens/extensions/metadata)、[ImmutableOwner](https://solana.com/docs/tokens/extensions/immutable-owner)。不请求元数据URI，不保存名称、描述或元数据原文。

转账税、转账钩子、永久代理、不可转账、暂停及其他未列入允许清单的扩展继续拒绝，哪怕同时带有元数据扩展。还会拒绝长度越界、重复TLV、错误账户类型、无效元数据结构及旧Token程序上伪装的扩展。原池子身份、程序所有权、金库归属、冻结、储备、新鲜度和预算检查继续保留。本修复只支持研究估价，订单执行器的扩展限制保持原样，不能据此认为实盘已支持这些币。

state_quote新增validationVersion=2和accountDiagnostics：包含baseMint/baseVault/quoteVault的地址、程序所有者、字节长度、扩展类型编号/名称/长度、拒绝类型及原因。成功和扩展拒绝都会记录诊断；RPC超时/缺账户时可能没有扩展诊断。quality.json的audit.stateQuotes.extensionRejections按账户角色和扩展类型汇总，结构错误按角色和原因汇总。数据自动进入现有COS模板，无需修改定时器。

部署后先看shadow_health.stateQuotes.validationVersion=2；再检查至少一条status=quoted、账户检查通过的state_quote及其后续state_exit_recovery。现有5次失败并不能证明服务器实际遇到的扩展都是允许类型，本地测试通过也不等于服务器真实报价已验证。请求预算不变，失败首次默认等待30秒，连续失败等待60秒、120秒后封顶（15秒是成功查询间隔，非首次失败间隔）。

### 买入后3秒内+8%快速止盈对照（exitResearchVersion=3）

新增 take8_first3s，当前共9个退出对照。以模拟实际入场proxy_entry时间开始计时，0至3000ms（包含边界）内，观察价格相对原模拟入场价上涨至少8%，触发quick_take_profit。8%沿用固定止盈的价格口径，不是保证净赚8%。触发后仍等待原退出延迟（默认500ms）及有效报价，按真实观察到的估价扣除研究成本；实际结果可能低于8%甚至亏损。

超过3秒未触发，不强平、不延长快速止盈窗口，继续原20%固定止盈、25%固定止损、10%启动/回落3%移动止盈和最长持仓规则。正常止损在前3秒也有效。这是单独的研究组，不叠加取消止损，不修改订单引擎或模型。

行情缺口不补造触发。缺口前已触发的快速退出意图会在独立恢复分支保留，之后的有效报价可以晚于3秒；缺口后的首次可见报价若已超过3秒，不能回填成快速止盈。连续标签和间断估价仍分开，费用、延迟、预算及数据源规则不变。

COS与quality.json的退出分组自动包含take8_first3s。assumptions记录quickTakePct=8、quickWindowMs=3000、quickTakeBasis=price_from_proxy_entry。部署重启后核对session.exitResearchVersion=3、exitVariants含take8_first3s；按买前评分组比较同候选配对净收益，同时检查触发数、延迟和缺失比例。

### 到期补报价与买入前过滤研究（2026-09-09）

session新增stateQuoteSchedulingVersion=2、selectionVersion=3；exitResearchVersion仍为3，退出组仍为9个。保留当前1 SOL配置、20%固定止盈、25%固定止损及模型，未把过滤条件接入订单引擎。

**补报价调度**：每个活跃恢复池携带各研究持仓的退出dueAt和expiresAt。已经到期的退出优先，其次按较久未查询顺序；同池共用快照。未来15秒内存在退出时，普通查询为它预留滚动分钟预算的最后一次请求。到期后如果此前请求早于该退出dueAt，允许一次新请求跳过旧的成功间隔或失败退避，至少与上次响应间隔1秒。到期请求失败后不会每秒重试；新到期意图可再获得一次尝试，始终受原总预算限制。预算已耗尽时仍可能无法报价，不能保证未知结果归零。

不延长持仓截止，不用提前请求的旧快照作为延迟退出成交，不合并不同报价来源，不修改原连续训练标签。独立后台请求不加入买入等待链路，原最多20池/80账户、单并发、3秒时效检查继续生效。

新增诊断：state_quote.scheduling含urgent/deadlineOverride/expiresAt，rpcDiagnostic只保存固定错误类别、数值RPC code或HTTP状态；不记录错误原文、请求地址或密钥。最小上下文slot未满足（-32016）单独标记minimum_context_slot。shadow_health.stateQuotes新增schedulingVersion、reservedBudgetSkips、backoffSkips、urgentPools、deadlineOverrides、rpcErrors。跳过计数按轮询轮次或池次，不是交易数；health的rpcErrors是请求批次，quality.json的rpcDiagnosticCategories/rpcCodes是池级结果数，不能混用分母。

**固定买前过滤组**（selection.version=3，规则ID独立于旧版）：

| 研究组 | 保留条件 |
|---|---|
| avoidWeakBuy | 砸单前15秒买入SOL金额占买卖总金额至少20% |
| avoidPriorFall | 砸单前60秒价格变化至少-20% |
| avoidLargeDump | 本次砸单严格小于40 SOL |
| prebuyCombined | 同时满足以上三项 |

使用砸单前特征，不把本次砸单加入历史买卖占比。所有组要求候选新鲜；历史不足、前15秒无买卖额、前60秒不足两次交易等相应条件记unknown，不用默认值判通过。砸单大小本身可在历史不足时单独判断。缺失记录不当失败或零收益；各过滤组重叠，不能相加收益。旧selection版本继续可分析，并按运行、规则ID、模型分组隔离。

四组自动进入quality.json的audit.selectionValidation（含退出配对、反弹/大跌标签和缺失率）以及audit.researchRecovery的独立来源分组。无需更改COS定时器或重新安装模型。

部署后保留.env/data及模型，按原安装步骤重启。15分钟后导出核对：

1. session.selectionVersion=3、stateQuoteSchedulingVersion=2；样本selection.arms含上述四组。
2. shadow_health.stateQuotes.schedulingVersion=2；请求滚动一分钟不超过配置上限。已有到期恢复时查看urgent、deadlineOverride和实际quoteRequestAt；无到期样本时计数为0是正常情况。
3. quality.json新增过滤分组与补报价诊断；如有RPC失败，检查category/code而不是把全部失败认定为超时。
4. 对比未知率时按新进程窗口、同来源和同规则统计，并同时检查成功补回的亏损。部署验证不能仅凭出现一次成功报价就认定采集完整。
