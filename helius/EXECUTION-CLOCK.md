# 执行等待与持仓计时 v2

实盘退出阈值不变：10%止盈、8%激活/3%回撤、20秒上限，无固定止损，10秒无行情退出。

## 账户读取

最低slot校验、processed读取、重试次数、信号期限不变。之前RPC返回slot落后后完整等待100/200/300ms；现在把刚才该次RPC已经消耗的时间计入该间隔。例如请求耗时70ms、间隔100ms，只再等待30ms。超过间隔时不额外睡眠；仍只对-32016重试，不增加最多调用次数，不新增后台RPC，不承诺同slot成交。

execution_account_read_failed 增加 schedulingVersion=2、rpcElapsedMs、retryIntervalMs，retryDelayMs为实际剩余等待。观察成功率与每笔请求次数，较早重试可能在节点未赶上时消耗原有重试机会，需要实际数据验证。

## 持仓时钟

新确认买入新增 holdingStartedAt，取发送前已落盘的 pending.submittedAt；这是保守的提交时间边界，不是毫秒链上成交时间。holdingClockBasis=submission_journal、holdingClockVersion=2。20秒在此基础上计算，确认耗时不再额外延长上限。无有效submittedAt时退回确认时间并标注confirmation_fallback。

openedAt仍保留原本地确认时点，旧heldMs继续表达确认后持仓时间；卖出增加exposureMs表达提交起的时间。真实成交只能由回执确认，20秒是开始退出上限，不保证20秒成交。未确认买入仍先核对回执，不凭超时发送盲目卖单。持仓字段落盘并跨重启保留。升级前旧持仓缺少holdingStartedAt时继续openedAt，不重置时钟。

## 卖出slot诊断

构建卖单前复制执行所需持仓字段，pending.swap不再引用不断被行情修改的持仓对象。triggerSlot/slotGap保持执行快照口径，不再因提交后行情更新出现负slot差。这里的slot是该次执行账户读取所要求的slot，不是最早策略触发slot；最早触发的行情仍看diagnostic.observation.slot。

## 独立早退研究

exitResearchVersion=5，共12组。新增 fast_exit_20s 与 fast_exit_20s_failure_3s；共享代理入场，均为10%止盈、8%激活/3%回撤、20秒上限、无固定止损。后者额外沿用既有三秒失败条件：净估值≤-8%、至少两笔卖出、卖额≥买额1.5倍、最后一秒净卖压，一次性评估后等待原研究退出延迟。

仅这两个对照用于比较新增早退，不影响实盘卖出或原训练标签。它们以代理入场时刻计时，不等价于实盘提交时钟；行情缺口仍为删失，补报价恢复单独记录，不能假装按旧价即时成交。因此不能宣称是包含实盘超时执行的完整复制。

## 部署核对

测试后按原流程保留.env/data/模型部署。starting.strategyConfig应有holdingClockVersion=2、executionAccountReadSchedulingVersion=2；session应有exitResearchVersion=5及12个变体。新buy_confirmed记录holdingStartedAt、holdingClockBasis和confirmationWaitMs；sell_confirmed记录exposureMs。自然出现slot追赶后核对实际retryDelayMs。研究无需额外RPC，沿用已有归档管道。
