# Helius PumpSwap 砸单程序 v5

新增独立入场时机研究：比较原入场、止跌回升2%且有两笔买单、止跌回升2%且有两个不同买家。研究重新计算各自入场和退出，仅采集、不控制买卖、不增加API请求。默认开启 `SHADOW_ENTRY_COMPARISONS=true`，核对方法见 [观察实验说明](helius/OBSERVATION.md#入场时机研究-v1)。

按全新服务器安装使用。行情和交易只连接 Helius，全市场监听 PumpSwap 代币/WSOL 池，无代币监控列表。另支持腾讯云 COS 每日分析归档。

默认：卖单至少 8 SOL、跌幅 10%–30%、卖后流动性至少 30 SOL；每次买入报价 1 SOL；同币冷却 30 秒，最多 20 个持仓，每分钟最多准备 6 次买单。卖空后 2 小时检查回收空 ATA 租金。已有服务器的 .env 显式金额优先，更新后请核对 POSITION_SIZE_SOL=1。

[Dashboard 运行面板](helius/DASHBOARD.md)：端口 8787，显示实际启动参数、持仓、交易、观察与上传状态。默认通过 SSH 隧道访问，不开放公网端口。

[安装与配置](helius/README.md) · [完整买卖策略](helius/STRATEGY.md) · [反弹样本与训练](helius/SHADOW.md) · [买入速度与延迟分析](helius/LATENCY.md) · [验证记录](helius/VALIDATION.md)

默认开启反弹观察：复用行情，记录买入前特征及之后 30/60 秒反弹和策略模拟结果，支持离线训练、校准及时间分区验证。特征采集在独立线程，不增加 Helius 请求；独立账户补报价研究使用有限额的 Helius RPC。没有模型时概率为空；加载模型后也只记录预测，暂不参与买卖。

最新更新：退出补报价优先处理到期持仓，在原每分钟 10 次预算内预留请求；记录脱敏 RPC 错误类别。默认 PAPER_PREBUY_FILTER=true：模拟买入直接拦截前15秒买入金额占比<20%、前60秒已跌超20%、砸单≥40 SOL，砸单前连续至少3笔卖出且前5秒净卖出、前5秒买入金额占比≥80%、已验证迁移AGE在[30,120)分钟的候选；任一命中即跳过。保留后台观察及新旧过滤研究组，不改变退出参数或实盘下单路径。部署与核对见 [观察实验说明](helius/OBSERVATION.md)。

补报价遇到最小slot未达到时，现支持2/4/8秒的有限重试，仍受原请求预算约束；新增历史未知允许/拒绝对照，执行归档自动按入场过滤状态汇总成本。当前模拟入场仍拒绝已知危险，历史未知的处理未改为硬拦截。

[每天北京时间 07:00 上传 COS](helius/COS-UPLOAD.md)：目标 guigu-1403019446 / na-siliconvalley。将密钥填入服务器 `helius/.cos.env` 后按说明启用定时器；下载每天的 analysis.jsonl.gz 和 summary.json 即可交回分析。随包附 [分析请求模板](helius/ANALYSIS-REQUEST.md)。

要求 Node.js 22 或更新版本及 npm。解压发行包后，在项目根目录执行：

```bash
npm run setup
cp helius/.env.example helius/.env
chmod 600 helius/.env
# 编辑 helius/.env，填写 Helius API key；默认 DRY_RUN=true
npm test
npm run benchmark
npm start
```

配置文件为 helius/.env。模拟模式消耗行情额度，不签名或交易。正式运行可采用 README 中的 systemd 安装步骤；仅启动一个服务实例。

无其他在途交易且网络/节点正常时，工程估算：收到推送到发起发送约 50–250 ms；砸单执行到买单执行约 0.5–2 秒。腾讯云尚未实测，费用竞争与确认锁可能明显扩大延迟或使机会被跳过，详见延迟分析。

即时检查最近一小时：`node helius/scripts/export-recent.js --hours 1`。每份日报新增 quality.json，区分缺失标签与负样本，并报告模拟毛盈亏和训练门槛。

新增[执行对照、模型观察与迁移 AGE分析](helius/OBSERVATION.md)：不改变买卖决策，复用 Helius 行情记录毕业迁移事件，未知迁移年龄保持为空。

2026-09-08：新增迁移事件接收/解析/缓存/命中诊断，以及逐笔 execution-audit.json。买卖阈值不变；更新后先用15分钟导出核对采集。

新增 `no_fixed_stop` 退出观察对照：仅在模拟研究中取消固定止损，保留止盈、追踪及最长持仓；原交易配置不变，结果自动进入每日归档。见 [观察与训练说明](helius/OBSERVATION.md)。

模型部署新增安装/检查工具，长期退出新增不连续观察恢复记录。详见 [观察部署说明](helius/OBSERVATION.md)。

按用户授权，已发布可直接从仓库安装的[冻结双评分模型](observation-models/20260908/README.md)。这一指定模型包作为发布例外，原始数据、密钥和其他训练产物继续保持私有。

新增30%/50%固定止盈（保留或取消固定止损）独立对照，以及有预算的Helius账户状态补报价。仅用于已入场研究持仓；连续标签与间断估价分开归档，不改变订单规则或已安装模型。默认最多10次补查询/分钟，详见 [观察与训练说明](helius/OBSERVATION.md)。

新增默认关闭的小额实盘校准模式：0.05 SOL、持仓上限可配1–20仓（默认20）、不限制总买入尝试和累计亏损；统计跨重启保留，强制六项过滤，并行同金额及1 SOL参考shadow。代码更新不会自动切实盘，启用与核对见[校准说明](helius/OBSERVATION.md)。

### Helius 流量归因（streamTrafficVersion=2）

每 60 秒产生一条 `stream_traffic`，正常停止时补写不足一分钟的部分；记录自动进入现有 COS `analysis.jsonl.gz`。仅复用现有交易解析和接收字节计数，无新增订阅或 RPC，不保存原始报文，不改变交易过滤或止损。

分类为 parsed_buy / parsed_sell / parsed_mixed（有效解析）、unparsed_swap（识别到买卖指令但未通过解析校验）、verified_migration（迁移验证通过，优先于买卖分类）、other_transaction（未识别到支持的买卖指令，不能据此断言没有 swap），以及重复、过期 slot、控制消息、错误、预算丢弃等。每条消息只计入一个分类，分类 byteCount 总和等于总 byteCount。这些是收到的应用消息字节，不是 Helius 账户账单，也不包含 RPC 请求费用。

池子统计取已识别买卖指令的池地址；多池交易平均分摊整条消息字节，属于估算。每分钟最多跟踪 2048 个池，输出前 20 个，其余分别进入 otherPoolByteCount / overflowPoolByteCount；没有池地址的进入 unattributedByteCount。候选池统计不表示其买卖已通过安全校验，更不能仅凭流量认定刷量。池名单每分钟清空，内存和日志量有界。

部署后检查 starting.strategyConfig.streamTrafficVersion=2，运行一分钟后应看到 stream_traffic；导出 15–30 分钟窗口即可开始定位流量来源：

```bash
node helius/scripts/stream-traffic-report.js /path/to/analysis.jsonl.gz > traffic-summary.json
```

汇总输出分类占比与池榜。池榜仅累加每分钟前 20 名，为下界估算，不是精确全窗口排名；每分钟统计可能跨导出边界，异常退出最多丢失最后一分钟的归因。旧归档没有原始报文，无法补算流量。若 intervals=0，说明文件内尚无新版统计，应先核对部署和导出窗口。

v2 新增 reasons：unsupported_pair、missing_instruction_accounts、multiple_pool_instructions、repeated_pool_swaps、missing_authenticated_swap_event、ambiguous_swap_event、missing_vault_balances、nonpositive_reserves、balance_direction_mismatch；其他交易细分 unsupported_amm_instruction / amm_event_only / no_amm_instruction。多原因消息按原因数均分字节（不是实际指令大小），messages 可重叠，不可累加当交易数。部分可解析的复合交易归 parsed_swap；原因表示首个未通过的校验，不是所有潜在问题。汇总兼容 v1/v2，reasonCoveredByteCount 明确原因统计覆盖的字节数，不能将旧版缺失原因当作零。

### 实盘卖出短重试（exitRetryVersion=1）

账户读取 -32016 且尚未写入待确认交易、或链上已确认卖出滑点失败（6004）时，重试资格等待依次为 250 / 500 / 1000 ms；每仓 60 秒窗口最多 3 次、全局最多 6 次短重试，超额以及其他失败仍等待 10 秒。每次重新读取账户和构建交易，保留原滑点上限。预算随账本保存，重启不会补满。短重试可能增加 RPC 次数，上限约束的是额外短重试，不是全部 RPC 请求。

重试由现有行情/1 秒维护循环驱动，以上是最早可重试时间，不保证毫秒级发出或成交。已失败退出意图会保留，即使行情变旧或价格回升，也继续完成退出。发送超时但有待确认签名时先核对链上结果，不重建交易；其他账户的待确认交易、全局执行锁仍可能延后退出。止盈20%、止损25%、买入金额和过滤条件不变。

部署后核对 starting.strategyConfig.exitRetryVersion=1；自然失败时应出现 exit_retry_scheduled（kind、fast、delayMs、预算计数），随后检查新 sell_submitted 的 triggerToSendMs 和真实回执，不能只看计划等待时间认定已恢复。没有自然失败时无该日志不算部署失败。
