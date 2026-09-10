# Helius PumpSwap 全网砸单版

## 小额实盘校准（默认关闭）

此模式用于测量实际执行与shadow偏差，不是证明策略已盈利。仅部署代码不会发送实盘订单，默认DRY_RUN=true、LIVE_CALIBRATION=false保持纸面。

启用配置（在实际运行的helius/.env中设置；本次代码更新不会代填钱包或切换模式）：

```dotenv
DRY_RUN=false
LIVE_CALIBRATION=true
CALIBRATION_SIZE_SOL=0.05
CALIBRATION_MAX_POSITIONS=20
CALIBRATION_MAX_BUYS=20
CALIBRATION_LOSS_LIMIT_SOL=0.1
STATE_FILE=data/calibration.json
SHADOW_ENABLED=true
```

另需配置专用钱包WALLET_PRIVATE_KEY_BS58及现有Helius凭据，密钥不入仓库。不要与其他交易程序共享钱包。已有持仓/待确认交易应使用原模式原账本先完成处理，不能换账本丢掉它们。校准买入拒绝已有WSOL账户，避免外部余额干扰；原实盘执行路径仍拒绝Token扩展币，准备失败必须单独统计，不代表所有候选都能执行。

校准持仓上限由CALIBRATION_MAX_POSITIONS配置（整数1–20，默认20），买币付款上限使用CALIBRATION_SIZE_SOL（上限0.05，交易费/tip及开户押金另计）；SDK滑点余量包含在该上限内，因此实际买入本金可能更小，忽略原POSITION_SIZE_SOL=1及MAX_CONCURRENT_POSITIONS=20。最多20次已签名买入尝试，包括失败和过期未落链，不是保证20笔成功买入；同一未知签名重试不重复记次数。不确定交易先核对，不能重新构建第二笔买单。

累计亏损默认0.1 SOL、上限0.1：逐笔已实现经济亏损加失败/关闭账户费用，盈利不抵扣已发生亏损。达到限额只停止新买入，仍核对pending、卖出持仓及回收账户。限额不包括未实现浮亏，也不能保证跳价、退出失败或持续退出费用不会超限。达到20次后同样只停止新买入。

预算、批次ID、已处理签名与买入成本保存在独立calibration.json，重启不清零；已有批次不接受改大限额，关闭校准模式也不能继续使用该账本。不要删除/改名账本来重置额度；下一批次应先导出分析并核对所有余额、挂单和账户回收，再另行安排。

六项过滤强制作用于校准买入，包括迁移AGE；历史unknown沿用原允许规则，worker不可用/超时或明确风险拒绝则不买。过滤、持仓与预算检查都在发送前；账户、余额、链上成交无法核对时阻止新买入。现有20%止盈、25%止损和移动止盈保持原配置。

### 对照与账务

同一Helius流同时生成same_size（0.05 SOL）和reference_1_sol（1 SOL）两份shadow，使用不同runId/policyId，不能合并收益。只让同金额shadow发原预算内补报价请求；1 SOL参考保留基准代理观察，不另发RPC、不复制全部退出研究。原冻结模型与1 SOL策略匹配，保留在参考组；同金额模型policy不匹配会明确标记，不强行复用概率。六项过滤不依赖这些评分。

链上calibration_receipt记录签名、来源信号、到账代币原始数量变化、提交/收到回执时间、落链slot、钱包SOL变化、托管ATA/WSOL账户lamport变化、meta.fee、已签交易tip和计算单元消耗。meta.fee已经包含优先费，不再次相加；不把配置值伪装成额外实测手续费。链上blockTime只有秒级，不宣称它是精确毫秒落链时间。交易以confirmed回执处理，关闭账户等待finalized；不能把confirmed当作最终不可回滚。

成交净收益由买卖两笔钱包现金变化加托管账户lamport变化核对，排除这些账户租金存入/退回的影响。失败交易费和close费用另外计入累计亏损；不要再从净收益重复扣meta.fee或tip。其他协议账户初始化支出可能仍在现金成本内，不伪装成可退租金；极端或缺失账务标记停止新买入。使用专用钱包，避免外部入金/转账或额外持仓干扰解释。

每日COS归档自动包含calibration.json快照及calibration.json.jsonl；execution-audit.json新增calibration对象，含真实回执和同信号的同金额shadow对照，另列1 SOL参考。配对失败/行情缺口保持unknown，不补零。该报告只配连续shadow结果，后续补报价记录仍在原归档中。面板原纸面盈利统计不代表本校准实盘盈亏，以calibration报告为准。

### 启动后核对

starting.strategyConfig.calibration.enabled=true、sizeSol=0.05、maxPositions=20（或配置的上限）；health.calibration包含batchId/attempts/lossSol/stoppedReason。shadow两份session分别有calibrationRole=same_size/reference_1_sol，sizeSol分别0.05/1。首笔先核对calibration_prebuy_filter、签名、calibration_receipt和实际代币数量，首次导出检查execution-audit.json.calibration。没有真实回执时不能宣布实盘校准完成。


## 最新：迁移后30–120分钟过滤（selectionVersion=7）

默认纸面过滤新增：已验证的Pump毕业迁移AGE在[30分钟,120分钟)时跳过买入，恰好30分钟拦截，恰好120分钟不拦截。AGE只接受since_pump_graduation_migration定义、pump_migrate_processed来源且状态为observed_processed_not_finalized的有效非负migrationAgeMs；不使用代币创建时间。原Age模块仍校验池/币匹配、证据冲突及证据是否在候选前已知。

AGE未知不算危险命中，沿用纸面允许unknown的处理；其他已知风险仍可拒绝。此条件是多个历史时段的减亏尝试，匹配样本小且有方向翻转，不代表迁移AGE具有已证明的因果风险。被过滤候选继续原后台观察，不增加RPC或等待。

核对session.selectionVersion=7、sample.observationVersion=selection-v7，拒绝check=migrationAge、reason=migration_age_30_to_120_minutes。prebuyBeforeAge保留上一版五项规则，avoidMigrationAge单独观察AGE，prebuyCombined改为六项规则；质量与恢复报告保留新旧组。原1 SOL、20%止盈、25%止损、模型及COS定时器保持不变。

独立入场确认研究及离线回放要求当前六项明确通过；AGE未知因此会跳过该研究，但不因此拒绝纸面买入。旧归档缺少可验证迁移证据时记未知，不用创建时间补齐。按规则版本和进程分开分析。


## 历史更新：前5秒买入占比过滤（selectionVersion=6）

默认纸面买前过滤新增：触发砸单之前5秒，买入SOL金额 /（买入SOL金额＋卖出SOL金额）≥80%就跳过。恰好80%也拦截；不包含触发砸单本身，不按笔数或地址数计算。需要完整历史、有效字段及正成交总额，缺失/零成交按unknown沿用原处理，不伪造危险命中。

这是基于多个已检查历史时段的减亏尝试；同币匹配差异不完全一致，未知结果仍存在，不保证未来盈利。被过滤信号继续原后台观察，无新RPC或等待窗口，不消耗纸面持仓、准备名额、冷却。只影响PAPER_PREBUY_FILTER=true且DRY_RUN=true的纸面买入；其他下单路径及退出规则保持原状。

核对session.selectionVersion=6、sample.observationVersion=selection-v6；拒绝原因priorBuyBurst / prior_buy_fraction_5s_at_least_80pct。新增avoidBuyBurst单项分组和prebuyBeforeBuy80（上一版四项规则）分组；prebuyCombined改为五项规则，prebuyLegacy仍保留最初三项。质量报告与恢复报告分别保留新旧组，缺失结果不填零。无需新配置、重装模型或修改每日COS任务。

离线入场回放随当前selection使用五项规则，旧归档缺失买入占比字段时按未知跳过。部署边界前后的结果按selectionId和进程分组，不直接混合。


## 历史更新：连续卖出压力过滤（selectionVersion=5）

默认 PAPER_PREBUY_FILTER=true 且 DRY_RUN=true 时，新增直接跳过条件：触发砸单之前的成交序列已连续至少3笔卖出，且前5秒卖出SOL金额严格大于买入SOL金额。两项必须同时成立；触发砸单本身不计入，连续3笔不要求同一卖家，也不限定都在5秒内。金额相等或只有2笔连续卖出不触发。

历史完整且字段有效才判断该条件；历史未知沿用原处理，不伪造危险命中。命中在持仓、准备名额和冷却消耗前拦截，原因记录为 consecutivePressure / consecutive_sells_3_and_net_sell_5s。沿用内存历史计算，不新增RPC、等待窗口或数据源。

后台仍保留所有可观察候选的原策略代理结果；prebuyLegacy保留原三项组合，avoidConsecutivePressure单独观察新条件，prebuyCombined及未知处理分组应用四项规则。观察仍受既有容量、行情连续性和期限限制，缺失结果保持未知。这是历史减亏证据支持的纸面防守尝试，不是已验证的盈利策略，不接入实盘下单路径。

部署后核对：session.selectionVersion=5，sample.observationVersion=selection-v5，selection.arms含prebuyLegacy及avoidConsecutivePressure；命中时paper_prebuy_filter应为reject并含consecutivePressure。quality.json的selectionValidation及researchRecovery会保留新旧分组；不修改COS定时器、模型、1 SOL配置或退出参数。没有自然命中不算部署失败。

离线入场回放现在统一使用当前四项过滤；旧归档缺少新特征时按未知跳过，因此不能把新版回放计数直接与旧版报告比较。旧归档原始标签不重写。


这是面向全新服务器安装的 v5。行情和交易只连接 Helius；不依赖 Shredstream.com、AllenHark、Birdeye，不使用代币监控列表。默认模拟模式。项目根目录的 `npm start` 和部署服务均指向本版本。另支持 [每天北京时间 07:00 上传 COS 分析归档](COS-UPLOAD.md)，COS 密钥在服务器独立配置，上传服务不参与交易决策。

## 已实现

- 一个 Helius `transactionSubscribe` 订阅，过滤 PumpSwap 官方程序 `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`，`processed`、成功非投票交易、base64、无奖励信息。监听所有调用此程序的交易，包括 CPI/聚合器路由，无需先发现或添加代币。
- 以 SOL 为计价资产，处理 PumpSwap **代币/WSOL 池**。不把其他 DEX、Pump bonding curve 或 USDC 报价池算作此范围。未知新指令会跳过，不猜测账户布局。
- 本地核对真实卖出事件、指令账户和交易前后池子储备；以卖家实际收到的 SOL 判断大单。识别虚拟报价储备。单笔大砸单即可触发，无须等待第二个卖家。
- 默认门槛：卖出 ≥8 SOL，池价下降 10%–30%，卖后实际 SOL 流动性 ≥30 SOL。单币冷却 30 秒；最多 20 个持仓；每分钟最多 6 个候选进入准备步骤。冷却从候选获准进入准备时开始，准备或买入失败也计时；已有同币持仓时不加仓。
- 失败交易、重复事件、同池多次 swap、同池混合流动性操作、旧 slot 和过期信号不买。无法准确归因的复杂交易宁可漏掉。
- 官方 PumpSwap SDK 构建买卖；链上读取由 SDK 的三次串行调用合并为一次批量调用。每次交易读池子、费用配置、mint、金库和用户 ATA，并核对池子/代币对应关系。
- 提前刷新 blockhash、保持 Sender 连接；砸单接收至发送的时间写入日志。发送失败只重发**同一份已签名交易**。发送返回不等于成交：确认回执后才建立/关闭持仓。
- 止盈、止损、移动止盈和最长持仓退出；流断开或达到流量上限后，停止新买单，已有仓位继续通过 Helius RPC 监控和卖出。
- 已签名未确认交易、持仓、回收计划、冷却和流量都落盘。重启恢复；未知交易阻止新的提交，避免重复买卖。模拟与实盘状态文件分开，禁止同一个状态文件启动两个进程。

## 全新服务器安装

新增反弹观察模块默认开启：在持仓、冷却和准备额度过滤前收集基础候选，后台跟踪 30/60 秒反弹及既定退出规则的估算结果。支持离线训练和校准，但尚无真实样本模型，概率默认为空，加载后也不干预交易。数据覆盖、费用假设、训练命令及参数见 [反弹样本与概率模型](SHADOW.md)。模块复用行情，不新增 Helius API 调用；使用独立工作线程，仍会消耗服务器 CPU、内存和磁盘。

要求 Node.js 22 或更新版本；推荐在 Linux 服务器使用 Node.js 22 LTS。

将发行包解压到新服务器目录。安装 Node.js 22 或更新版本及 npm；手动运行时，在解压后的项目根目录执行：

```bash
npm run setup
cp helius/.env.example helius/.env
chmod 600 helius/.env
# 编辑 helius/.env，填写 HELIUS_API_KEY，先保留 DRY_RUN=true
npm test
npm start
```

也可以进入 `helius/` 后执行 `npm ci && npm start`。**配置文件为 `helius/.env`**，根目录 `.env` 不读取。操作系统已有的环境变量优先于此文件。

模拟模式无需私钥，也不会签名、买卖、关闭账户，但实时 Helius 行情仍会消耗额度。模拟成交按观察到的池价计算，未模拟竞争排序、滑点、价格冲击、手续费或失败交易，不能将模拟利润当作实盘收益。

实盘配置 `DRY_RUN=false` 和 `WALLET_PRIVATE_KEY_BS58`。使用专门的策略钱包。程序只记录自己的买卖及其账户回收计划，不自动接管钱包已有代币。全新服务器会自动创建状态目录和文件，无需迁移数据库或处理其他进程。

本版本提供运行日志、命令行测速及 [Dashboard 网页面板](DASHBOARD.md)，默认监听 127.0.0.1:8787。面板为独立只读进程；不提供人工加币或交易操作。默认买入金额为 1 SOL；已有 .env 仍优先，更新后应核对 POSITION_SIZE_SOL=1 并重启交易服务。

## 尽量节省 Helius 消耗

2026-09-07 核对的官方计费：普通 WSS、Enhanced WSS 和 LaserStream 均为每 0.1 MB 未压缩数据 2 credits，即约 **20 credits/MB**。普通日志订阅也不是免费。最终以 Helius 控制台实测为准。

这里采取的节省措施：

1. 只订阅 PumpSwap 程序，不订阅整条 Solana 链、独立 Jupiter 全量流、多个重复地区流或每币账户流。
2. base64 完整交易替代 jsonParsed；关闭奖励信息。不对每笔推送再调用 `getTransaction`，从推送内的 CPI 事件、余额和 ALT 加载地址解析。
3. 不拉代币名称、图标、价格历史、FDV、24h 成交量，不做全池扫描。仅本地筛出的候选和自己持有的池需要读 RPC。
4. 无持仓时不轮询池子。实盘 blockhash 默认 15 秒一次，约 5,760 请求/天；有持仓才每 15 秒批量读取这些池子及金库。仅 pending 交易每秒查确认状态；仅成交确认后查回执。
5. `MAX_CANDIDATES_PER_MINUTE` 限制候选准备 RPC。`MAX_STREAM_MB_PER_DAY` 可设置每天 UTC 的接收流量上限；到上限断开全市场流，次日恢复，期间会漏掉新砸单。已有仓位维持 RPC 退出监控，后备价格更新最快为 `POSITION_POLL_MS`。
6. 健康日志每分钟输出 `streamMBToday`、`estimatedStreamCreditsToday`、`rpcRequests`。流量为客户端接收到的未压缩消息字节，credits 仅估算流部分；不含 RPC、连接费用、控制台计费口径差异或停机前未落盘的最后一分钟。

示例：若接收 100 MB/小时，则流消耗约 48,000 credits/天、144 万/月。**这是计算示例，不是对 PumpSwap 实际流量的测量。** 先跑一段模拟，按控制台实测选择额度。

重要限制：Helius 公布的这个订阅过滤器不能按“卖出多少 SOL/跌幅多少”在服务器侧筛选，完整市场识别仍然要接收程序匹配流。在本地把门槛从 20 改成 50 SOL，只减少候选读取和交易，不减少已接收的流量。普通 `logsSubscribe` 缺少本实现所需的 CPI 指令/账户余额，换它后逐笔补交易往往更慢。

当前实现是单连接 WebSocket，不是 gRPC 或 preprocessed 模式。若全市场长期运行的流量账单很大，可比较 Helius LaserStream Plus 大流量套餐和二进制 gRPC；这需要单独测量与适配，不能保证切换协议本身就降低账单。

候选限制是本程序为控制准备阶段 RPC 消耗设置的额度，不是 Helius 的硬性要求：通过本地筛选、持仓/冷却/去重等检查后，每个自然分钟最多允许 6 次准备尝试。准备包括读池子与钱包账户、检查可交易性、构建和签名；失败或过期也占用一次。额度用尽后跳过该分钟余下新候选，不排队到下一分钟，卖出不占用此额度。这个限制能省候选查询，不能减少全网订阅流量；行情集中时也会漏单。可在 `helius/.env` 调整 `MAX_CANDIDATES_PER_MINUTE`（1–1000），目前保留 6。

完整的当前规则和触发例子见 [买卖策略明细](STRATEGY.md)。

## 下单速度和配置

完整逐步骤审查、测速记录和预估见 [延迟分析](LATENCY.md)。无其他在途交易、网络和节点正常、交易成功落链时，规划估算为：**收到砸单推送到发起发送约 50–250 ms；从砸单执行到买入被执行约 0.5–2 秒；程序观察到 confirmed 并登记持仓约 1–4 秒**。这不是腾讯云实测或延迟保证。确认锁忙、限流、网络超时、交易竞争或失败时不适用。

已消除重复 base ATA 创建指令；Sender ping 会读完响应体，以便复用连接；区块哈希缓存过期时与池子读取并行刷新。为防止重启后重复买入，发送前的可靠落盘保留。

日志现在区分 `stateMs`、`buildSignMs`、`journalMs`、`receiveToSendMs`、`senderAckMs`；确认日志记录来源 slot、成交 slot 及差值。`receiveToSubmitMs` 包含服务端响应等待，`confirmMs` 是程序观察到确认所耗时间，不是精确的链上执行时间。

热路径没有第三方 HTTP、元数据查询、固定等待窗口或等待第二单。读取池子时使用 `processed` 并设置来源 slot 下限，避免拿到砸单之前的链上状态。构建后再次检查信号时效，默认接收后 2.5 秒内才能提交；事件时间允许额外一秒的链上秒级时间误差。

第一次遇到的池子仍需要一次链上批量读取，不能承诺零 RPC。低延迟不等于保证紧接卖单排在下一笔：leader 调度、其他交易、网络路由、优先费、Sender tip 都会影响落块顺序。这里未使用预执行 shreds，因为预执行数据没有执行后的池子余额，不能直接证明大砸单实际完成。

费率均可调：默认 `PRIORITY_FEE_LAMPORTS=100000`、`COMPUTE_UNIT_LIMIT=300000`、`SENDER_TIP_LAMPORTS=200000`。买卖均经 Sender，包含优先费和 tip。双路 Sender 文档最低 tip 为 200,000 lamports；最低值不保证竞争成功。需要减少 tip 可选 `?swqos_only=true` 并将 tip 配为 5,000 lamports，但放弃双路发送覆盖。代码没有直接连接独立 Jito 服务，Sender 内部路由由 Helius 完成。

`POSITION_SIZE_SOL` 是 SDK 报价输入；实际最大支出可能按 `BUY_SLIPPAGE_BPS` 上浮，还要加链上费、tip 和首次账户租金。止盈止损触发依据池子现价，建仓成本包含入场手续费和 tip；实际平仓净收益还受退出滑点、价格冲击和退出费用影响。

支持普通 SPL Token 和无扩展 Token-2022。含 transfer fee、transfer hook 等扩展的 mint，以及有冻结权限的 mint，当前执行路径明确跳过，避免不正确报价。

## 卖出两小时后回收账户租金

```dotenv
CLOSE_ACCOUNT_AFTER_MS=7200000
CLEANUP_INTERVAL_MS=60000
```

仅为本程序成功买入时新建、并确认卖空的 base token ATA 建立回收计划。卖出确认时开始计时，默认到期后一分钟内检查；服务离线则下次启动恢复检查。到期前再次买入，pending 状态阻止回收；重新买入确认后取消旧计划，下一次卖空再重新计时。

关闭前验证：ATA 地址正确、SPL/Token-2022 程序正确、mint 和钱包 owner 匹配、余额为零、close authority 可用、没有持仓或在途交易。买入和回收共用互斥锁。空账户检查后有人转入代币，链上的 CloseAccount 会失败，不能把非空普通代币账户关闭。

回收使用 Helius 普通 RPC，执行 preflight，不额外付 Sender tip。租金退回同一个交易钱包；网络交易手续费不能退。普通 ATA 常见租金约 0.00203928 SOL，但依账户大小和链上实际余额而定。不会烧毁零头，不关闭钱包主账户、不关闭其他币账户，也不自动关闭 PumpSwap 用户累计器等程序账户。

WSOL 临时包装账户由 SDK 在交易中处理，可能立即关闭，不套用两小时逻辑。若希望进一步减少 WSOL 创建/关闭的计算量，需要另做常驻 WSOL 余额与资金管理，不应仅删除 SDK 的关闭指令。

## 腾讯云美国硅谷部署

建议从下列组合起步，随后在服务器实测：

```dotenv
HELIUS_SENDER_URL=http://slc-sender.helius-rpc.com/fast
# HELIUS_RPC_URL / HELIUS_WS_URL 默认使用 mainnet.helius-rpc.com
```

SLC 为盐湖城，是地理上合理的首个候选，**不是已测最快**。WebSocket 使用 Helius 文档统一入口，不能随意拼接不存在的“硅谷 WS 节点”。如已有专用 RPC，应填 Helius 控制台给出的实际地址。

在腾讯云服务器执行：

```bash
npm run benchmark
```

工具比较 SLC、EWR、全局 HTTPS Sender 的 warm p50/p95 延迟，并读一次配置的 RPC blockhash；不发交易。这个工具只测网络/RPC，不测落块速度；最终还要比较 `receiveToSubmitMs`、`confirmMs` 和实际交易 slot。

配置系统时间同步，否则时效过滤会误判。腾讯云安全组允许 DNS、出站 HTTPS/WSS 443 和选择区域 Sender 时的 HTTP 80；本版本不需要入站 UDP、旧 shred 端口，也不需要公开网页管理端口。不要为本程序关闭整台机器的防火墙。

项目根目录提供 `deploy/install.sh` 和 `dump-sniper.service`。新服务器准备 Node.js/npm、rsync、sudo 和 systemd，并确保运行用户存在。默认运行用户为 `ubuntu`；如你的服务器使用其他普通用户，通过 `SERVICE_USER` 指定。Node.js 应安装到该用户可执行的路径。安装脚本仅安装，服务配置使用 `helius/.env`，日志通过 journal 查看。

```bash
sudo bash deploy/install.sh /opt/dump-sniper
# 填写 /opt/dump-sniper/helius/.env
sudo systemctl enable --now dump-sniper
journalctl -u dump-sniper -f
```

例如运行用户为 `lighthouse` 时，安装命令为 `sudo SERVICE_USER=lighthouse bash deploy/install.sh /opt/dump-sniper`。手动 `npm start` 和 systemd 服务二选一，避免同一策略启动两份。

## 验证与运行边界

固定组合观察：每个候选记录金额/卖压、风险概率、预期净收益及组合筛选结果和原因。导出的 `quality.json → audit.selectionValidation` 自动按进程启动批次、规则、策略和模型版本分组，列出配对净收益、缺失率、大亏率及分小时统计。仅观察，不改变订单；模型未配置则相关筛选为未知。详见 [说明](OBSERVATION.md)。

新增风险/收益离线训练目标 `loss_25`、`net_return`，训练校准和测试均使用运行时的异常特征过滤。可分别配置观察模型，预测只落盘，不控制订单。默认新增 250ms / 1000ms 退出延迟及净收益 5% 提前止盈三组观察对照，另增加取消固定止损、保留止盈/追踪/最长持仓的 `no_fixed_stop` 方案，自动进入每日 COS 归档；真实买卖阈值不变。配置、训练命令与结果解释见 [观察与训练说明](OBSERVATION.md)。

本地测试覆盖 legacy/v0/ALT 交易解析、CPI 事件归属、虚拟储备、多跳过滤、阈值、过期信号、去重、真实 SDK 买卖序列化、持仓回执、未知提交恢复、ATA 关闭权限与余额、重入计时和状态重启。测试使用合成链上数据，没有向主网发送交易。

本次 99 项测试全部通过，包含新增样本时序、缺失标签、离线训练、模型校验、真实工作线程写盘及 COS 归档/重试测试；详见 [验证记录](VALIDATION.md)。发行 zip 包含独立运行所需代码、锁文件、说明和测试，不包含 node_modules、采集数据、训练模型或密钥。

没有 Helius API key 或腾讯云 SSH 会话，因此本次未验证真实全网订阅权限、服务端数据样例、24h 用量、腾讯云网络延迟或小额实盘成交。默认保持模拟。若日志中长期 `transactions>0` 而 `parsedSwaps=0`，先检查事件/IDL 格式，不应直接切换实盘。

遇到 `pending_needs_attention`，说明回执长时间无法确定；程序保留在途记录并停止新提交。不要删除 pending 来“解锁”，应先核对链上签名和钱包余额。进程强杀留下的锁会在原 PID 不存在时自动恢复；若状态文件损坏或钱包不匹配，启动失败，不把它当成空仓重置。

## 官方依据

- [Helius 额度与流量计费](https://www.helius.dev/docs/billing/credits)
- [WebSocket transactionSubscribe 参数](https://www.helius.dev/docs/api-reference/rpc/websocket/transactionsubscribe)
- [Helius Sender 节点、tip 和 ping](https://www.helius.dev/docs/sending-transactions/sender)
- [LaserStream 与预执行数据的区别](https://www.helius.dev/docs/laserstream)
- [PumpSwap 官方说明：有效报价储备](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)
- [PumpSwap 官方 IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)：`src/pump-layout.json` 为 2026-09-07 获取后提取的买卖布局。执行 SDK 固定 1.19.0，锁文件随项目交付。

双评分观察支持反弹≥60%且60秒大跌风险<25%的独立筛选，以及反弹≥80%的退出对照分组；需另行加载两个冻结模型。原交易策略不变，完整配置见 OBSERVATION.md。

新增长期恢复观察：池行情间隔后保留独立no_stop_recovery研究结果，原严格标签保持删失；提供install-observation-models.js安装及检查双模型。更新后按OBSERVATION.md部署并导出核对。

新增 take30/take50/take30_no_stop/take50_no_stop 退出对照；默认开启 SHADOW_STATE_QUOTES，仅对中断后的研究持仓按需批量查询Helius账户状态，每分钟最多10请求。所有估价独立记录，不覆盖原训练标签或订单规则。请求统计、成本上限、缺失口径及部署核对见 [观察与训练说明](OBSERVATION.md) 的 exitResearchVersion=2 章节。

Token-2022补报价修复：允许经结构校验的元数据扩展与ImmutableOwner，继续拒绝转账税/钩子及未知扩展；失败记录包含具体账户、长度和扩展类型，quality.json新增扩展拒绝汇总。仅影响研究估价，不放宽订单执行限制，详见OBSERVATION.md。

新增 take8_first3s 独立研究组：模拟买入后3秒内价格上涨8%触发止盈，仍等待原退出延迟；超过3秒回到原退出规则。每日COS自动收录，订单参数不变。部署后exitResearchVersion=3、共9个退出对照，详见OBSERVATION.md。

校准持仓配置可直接沿用旧calibration.json，修改上限不会重置batchId、attempts、lossSol或持仓。下调上限不会强卖已有仓位，只限制后续买入。20仓表示最多同时持有20个币，交易构建/发送与待确认核对仍串行；六项过滤、每分钟候选预算、冷却和20次总买入尝试限制继续有效。0.1 SOL是已实现亏损停止入场线，多仓浮亏与退出费用可能使最终亏损超过该值。钱包还需预留交易费、tip和开户押金，不能按余额除以0.05就认定可买满20仓。部署保留.env和账本，建议显式设置CALIBRATION_MAX_POSITIONS=20。
