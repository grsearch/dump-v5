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

模型、对照与年龄缓存都在原观察线程运行；新增数据复用行情，不增加 Helius 请求。买入路径不等待模型、年龄查询或实验结果。每个策略目标多一条 comparison 日志，增加本地磁盘和归档体积；年龄缓存写盘也共享机器资源。日报及小时归档自动包含这些记录，不需要改变 COS 定时器。99 项本地测试通过，包括迁移事件及指令联合认证、未知年龄、时序隔离、观察缺失、对照版本、钱包阻塞诊断及归档分组。

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

本次不更改买卖参数，不让模型决定订单。新增功能在观察线程运行，复用已有行情，无额外 Helius 请求。程序仍不自主训练或替换模型。

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

## 四组固定退出对照

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

quality.json 的 audit.selectionValidation.groups 每组新增 reboundBySelection（完整60秒的反弹/大跌/两者都发生/未知），exitsBySelection（同候选原策略与四种退出对照的配对收益、差额、50%深亏、未配对数）。按运行、策略、规则及模型ID分组，兼容旧v1。无完整配对时金额为null，不把缺失结果当作0收益或回本。归档出口自动包含新字段，无需调整北京时间7点的定时任务。

## 间断后的独立长期观察（recoveryVersion=1）

开启SHADOW_EXIT_COMPARISONS时，已有模拟入场且no_fixed_stop尚未完成的样本，在池行情间隔、旧行情、无法报价、断流或队列覆盖中断时，可进入独立恢复观察。原strategy_proxy、反弹标签与四组exit_comparison仍按原规则删失，不改成成功；恢复记录为no_stop_recovery，coverage=discontinuous，不供原训练目标使用。

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
