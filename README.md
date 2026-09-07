# Helius PumpSwap 砸单程序 v5

按全新服务器安装使用。行情和交易只连接 Helius，全市场监听 PumpSwap 代币/WSOL 池，无代币监控列表。另支持腾讯云 COS 每日分析归档。

默认：卖单至少 8 SOL、跌幅 10%–30%、卖后流动性至少 30 SOL；每次买入报价 0.1 SOL；同币冷却 30 秒，最多 20 个持仓，每分钟最多准备 6 次买单。卖空后 2 小时检查回收空 ATA 租金。

[安装与配置](helius/README.md) · [完整买卖策略](helius/STRATEGY.md) · [反弹样本与训练](helius/SHADOW.md) · [买入速度与延迟分析](helius/LATENCY.md) · [验证记录](helius/VALIDATION.md)

默认开启反弹观察：复用行情，记录买入前特征及之后 30/60 秒反弹和策略模拟结果，支持离线训练、校准及时间分区验证。独立线程处理，不增加 Helius 请求。没有真实数据训练的模型时概率为空；加载模型后也只记录预测，暂不参与买卖。55 项本地测试通过，尚无真实行情模型或实盘胜率结果。

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
