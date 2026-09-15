# Solana 老币放量趋势研究

`selected_pool_momentum_v2`：**只开 shadow，没有钱包、签名或交易提交路径。** 旧砸单、迁移AGE和实盘过滤条件不参与这套策略。

## 数据分工

- **DexScreener免费API发现和FDV筛选**：轮询最新/更新资料、boost列表及SOL关键词搜索，将其发现的Solana代币缓存，分批更新交易池信息。FDV必须严格大于30,000 USD；缺失不通过。Boost只是发现来源，不代表自然热度或可信度。
- **Jupiter核验首池年龄**：`tokens/v2/search`只补充已发现地址，使用`firstPool.createdAt`，收录年龄1–14天（含边界）。未知不收录。不使用代币创建时间、单个池的pairCreatedAt或Pump毕业迁移时间代替。
- **Helius资金流**：先批量核验池账户owner，只对入选池地址作transactionSubscribe；没有候选就没有订阅，绝不退回全网程序订阅。实际60秒资金流来自Helius交易，不用DexScreener五分钟量推算一分钟量。
- **Jupiter shadow估价**：只调用GET `/swap/v1/quote`，无需钱包的Metis报价接口。该接口仍可用但官方已标为不再积极维护；未使用需要taker的Swap v2订单/执行接口。API key仅在服务端环境配置，绝不进日志、面板或仓库。

**覆盖是DexScreener发现子集，不是Solana全网完整枚举。** 免费公开API没有按AGE/FDV分页枚举全网的端点。每个候选优先保留一个流动性较高且已支持的池，默认最多20池；一分钟量是该监控池的量，不是代币全部DEX合计。现有有效池优先保留，防止每分钟替换导致无法预热；因此不会自动覆盖所有新出现的高量机会。

## 跨DEX解析范围

支持PumpSwap、Raydium CPMM/CLMM、Meteora DLMM/DAMM v2、Orca Whirlpool swap/swap_v2。Raydium旧AMM v4、Orca原生two-hop及未实现的池型记为未覆盖，不冒充全DEX解析。经Jupiter等路由器调用以上标准swap指令可以解析；同交易重复操作同池或夹杂同池流动性操作时排除，避免归属错误。

账户布局来源：
- [PumpSwap官方IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json)
- [Raydium官方IDL](https://github.com/raydium-io/raydium-idl)
- [Meteora DLMM官方IDL](https://github.com/MeteoraAg/dlmm-sdk/blob/main/idls/dlmm.json)
- [Meteora DAMM v2官方IDL](https://github.com/MeteoraAg/damm-v2-sdk/blob/main/src/idl/cp_amm.json)
- [Orca官方生成指令](https://github.com/orca-so/whirlpools/tree/main/rust-sdk/client/src/generated/instructions)

资金量只计报价币一侧净池余额变化，包含池费影响，不等同用户钱包净收付；价格使用该笔平均交换价，不把CLMM/DLMM储备比例当现价。报价币USD由Jupiter元数据估计，超过120秒未成功更新不能统计；任意报价币须有有效USD信息。地址数量不等于真实人数。时间窗口以本机收到交易时间计，processed数据可能回滚，不是finalized账本。

## 研究买卖规则

- 每池连续连接预热6分钟。最近60秒量达到10,000/20,000 USD两档，且达到之前5分钟平均每分钟量的3倍；基线排除当前分钟。
- 60秒净买为正、10秒净买为正、至少5笔交易、3个买家地址。
- 比较直接突破前5分钟高点，或突破后回到突破位±1%、再站上突破位的回踩入场。预选有效3分钟。
- 2档量×2种入场×2种退出，共8个独立组。每笔0.05 SOL；组间不合并为组合收益。
- 信号至少等待500ms，随后取得新的Jupiter报价并重新检查资格、最新资金流。使用报价minimum-out作为保守模拟数量，原始整数不转浮点；入场冲击上限2%。Jupiter路由内费用不再重复加1%池费。另假设每边网络成本0.000305 SOL，未模拟真实成交、账户租金和拥堵排队。
- 净价值盈利20%激活/峰值回撤8%，或盈利40%激活/回撤12%。无固定止盈、固定亏损百分比止损、最长持仓。
- 跌破冻结突破位3%且30秒净卖压也触发退出。信号至少500ms后取得新卖出报价才完成模拟平仓。
- 默认每2秒请求持仓报价；相同币、相同数量的同时请求共享一次响应。行情或有效报价缺口超过15秒、断线、重启记unknown，不能把未知当0或用旧价虚构成交。无报价不是已确认无法卖出。
- 候选过龄/FDV刷新失效停止新入场；已持有模拟仓的池订阅保留至退出或结果未知。

阈值为研究初值，尚无盈利证明。报价不保证将来真实成交。日志按策略版本隔离，新旧收益不能混合比较。

## 预算与运行

默认20个候选池，另保留未退出研究仓池；最多40个独立研究仓。Dex请求最多30次/分钟、Jupiter共享预算120次/分钟、Helius RPC 6次/分钟。达到报价预算可能导致缺失结果，面板/日志记录跳过，不能据已知结果推断总体收益。

流量上限默认20GB/UTC日，达到后停止接收并将持仓记unknown，下一个UTC日才重试。这是硬预算，不是预计消耗。实际省多少应观察定向订阅后的字节速率；热点池仍可能很大。

Node.js≥22；`npm ci --prefix helius`，填写`helius/.env`中的Helius和Jupiter key。`npm test`；`npm start`。不存在实盘开关。`DRY_RUN=false`等旧环境项无效。

`sudo bash deploy/install.sh`同步程序，保留`.env/.cos.env/data`。安装脚本不自动启动采集。当前用户要求暂停，部署后保持dump-sniper停止，待明确恢复再启动；dashboard可单独重启。面板8787，外网访问需要原有访问令牌。

## 数据与归档

日志`helius/data/trend-YYYY-MM-DD.jsonl`包含发现资格、预选前历史、入场/退出信号、报价、模拟结果、unknown和预算统计。`trend-state.json`持久化发现目录；重启不恢复未完成模拟仓，不沿用预热历史。

北京时间每天07:00上传前24小时`analysis.jsonl.gz`、`summary.json`到原COS bucket的新策略前缀`old-pool-momentum/daily/`。summary按策略版本及研究组分别汇总，并提供SHA256；旧版本新策略数据保留，不删除。完整性验证不代表行情无缺口。
