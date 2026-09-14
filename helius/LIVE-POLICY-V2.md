# 实盘策略 v2

实盘及实盘校准统一采用：最小砸单 >=7 SOL；固定止盈20%；移动止盈盈利10%激活、最高价回撤3%；20秒持仓上限；同币确认净亏损后冷却60秒。继续关闭固定止损，保留10秒行情超时退出。持仓上限仍按holdingClockVersion=2的提交日志时间计算，不改执行安全与回执核对。

配置为liveExitPolicy.version=2、liveEntryPolicy.version=2。实盘minSellSol固定7，即使保留旧.env MIN_SELL_SOL=8也以7为准；启动strategyConfig.minSellSol及liveEntryPolicy.minSellSol均应为7，lossCooldownMs=60000，liveExitPolicy为takeProfit20/trailArm10/trailDrop3/maxHoldMs20000。

已有10分钟亏损冷却在升级启动时按原亏损时点缩短为1分钟，不从重启重新等1分钟；以lossCooldownDurationMs记录迁移，重启不重复缩短。普通同币30秒冷却、储备>100SOL、毕业0–30分钟、<50SOL永久停止新买入等不变。已提交或已保存的退出意图继续执行，避免重复交易。

运行中的Shadow候选接收当前7 SOL信号范围，会开始记录7–8 SOL候选。旧固定研究退出组和其10分钟研究冷却定义不覆盖改写；fast_exit_20s等既有研究组仍是10%止盈/8%激活的固定实验，不是本版实盘镜像。纸面MIN_SELL_SOL默认7，但纸面模式仍尊重其.env配置。

部署时保留.env、data、模型，核对以上启动参数；自然确认亏损后核对live_loss_cooldown_started截止时间为回执观察时间+60000。自然出现7–8SOL且其余条件通过的信号才可能成交，无命中不表示配置失效。每日归档沿用现有流程。
