# 实盘行情超时退出

默认 `QUOTE_TIMEOUT_MS=10000`，仅作用于真实持仓（含实盘校准）。从买入确认建立持仓开始，或最后一笔有效同池交易流报价开始计时，连续满 10 秒即启动退出，不再额外等待。正常持仓的 RPC 轮询报价不刷新这个时钟。延迟到来的报价在刷新时钟前检查已发生的超时。

退出原因 `quote_timeout` 贯穿 `exit_triggered`、`sell_submitted`、`sell_confirmed`、校准回执及归档，面板交易原因翻译为“行情超时退出”。`exit_triggered` 含最后交易流报价时间、发现时间、实际缺口和阈值；卖单 diagnostic 包含该诊断。

一旦触发，退出意图先落盘。行情恢复不取消，等待其他交易、构建失败或重启后仍继续。原有已触发退出原因优先；当前有效价格已满足原止盈止损时仍使用原原因。使用现有 buildSwap 账户读取与校验来获取可执行报价，不新增全市场轮询，不放宽滑点，也不在结果未知时重复提交。构建失败沿用现有退出重试。每秒维护检查不是成交时限：RPC、待确认交易和重试等待可能延迟执行。

老账本没有 lastStreamQuoteAt 时使用 openedAt，不用上次 RPC 报价或重启时间假装行情刚更新。因此更新时旧持仓可能马上满足超时退出。新字段和退出意图随持仓保存。

纸面成交与 Shadow 对照暂不增加本规则：缺口中的旧 spot 价不能当作当前可成交价格。不能直接用原 Shadow 收益评价本实盘规则。

## 更新验证

1. 更新前核对持仓和待确认交易，按原部署流程保留 .env、data 和模型。
2. starting.strategyConfig.quoteTimeoutMs 应为 10000（已有显式环境配置则核对其值）。
3. 自然超时后核对 exit_triggered.reason=quote_timeout 及持仓 exitRetryReason；不要求必须自然命中。
4. 核对 sell_submitted / sell_confirmed 同一签名原因一致，面板显示中文。提交不等于确认；失败查看 exit_retry_scheduled / operation_error。
5. 每日 COS 自动包含原交易事件及公开参数，无需改定时器。
