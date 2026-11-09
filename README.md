# wxq-data · 王者万象棋公共统计快照

每天自动收集一次「王者万象棋」（万象大赛）王者段位的棋手榜与阵容榜，把当天的原始快照提交进本仓。
供 [wxq-helper](https://github.com/aifyus) 对局助手（本地应用，代码不公开）直接拉取；任何人也可以拉。

- **更新时间**：每天北京时间 06:00 左右（GitHub Actions 定时任务，UTC 22:00）。
- **来源**：[wxq666.top](https://wxq666.top) 的公开接口（`/api/v1/meta`、`/lords`、`/lineups`）。
- **收集方式**：仓内 `collector/` 的脚本，每次只打 13 个请求（1 个 meta + 2 段位 × 3 窗口 × 2 榜），请求之间间隔 300 毫秒。

## 文件结构

```
latest.json                  最新一天的全部快照（平时只需要拉这一个）
index.json                   有哪些日期、每天的来源 / 窗口 / 段位 / 行数、生成时间
snapshots/YYYY-MM-DD.json    每天一个文件（北京日期），历史曲线按需拉
collector/                   收集器（运行副本；源码在 wxq-helper 的 sync/，改动两边同步）
.github/workflows/collect.yml  定时任务
```

### `latest.json` / `snapshots/*.json` 的形状

```jsonc
{
  "date": "2026-11-10",                      // 北京日期
  "generatedAt": "2026-11-09T22:03:11.000Z", // 这份文件最后生成的时刻
  "snapshots": [                             // 一个窗口 × 段位 = 一个快照，目前 1/3/7 天 × 王者1000+/5000+ = 6 个
    {
      "window": { "source": "wxq666", "windowDays": 7, "segment": "king-1000", "version": "daily-…", "gameType": "wanxiang", "fetchedAt": "…", "dateStart": "…", "dateEnd": "…" },
      "stats":   [ { "kind": "player", "sourceId": "lord-…", "name": "…", "appearanceRate": 0.12, "firstRate": 0.18, "top3Rate": 0.43, "avgPlacement": 3.68, "count": null, "raw": { /* 来源原始对象 */ } } ],
      "lineups": [ { "sourceId": "…", "name": "…", "camps": ["…"], "appearanceRate": 0.1, "firstRate": 0.1, "top3Rate": 0.3, "avgPlacement": 4.1, "count": null, "members": null, "raw": { } } ],
      "meta":    { /* 来源这次窗口的统计信息：样本量、阈值、起止日… 原样保留 */ }
    }
  ]
}
```

百分比字段统一换成 0–1 的小数；来源没有「场次」字段，`count` 为 `null`。
完整类型定义见 `collector/sync/sources/types.ts`。

### `index.json` 的形状

```jsonc
{
  "generatedAt": "…",
  "latest": "2026-11-10",
  "days": [
    { "date": "2026-11-10", "generatedAt": "…", "sources": ["wxq666"], "windows": [1, 3, 7],
      "segments": ["king-1000", "king-5000"], "snapshots": 6, "rows": 126, "lineups": 247,
      "file": "snapshots/2026-11-10.json" }
  ]
}
```

## 怎么拉

直接用 GitHub 的原始文件地址：

```
https://raw.githubusercontent.com/aifyus/wxq-data/main/latest.json
https://raw.githubusercontent.com/aifyus/wxq-data/main/index.json
https://raw.githubusercontent.com/aifyus/wxq-data/main/snapshots/2026-11-10.json
```

画多天曲线：先拉 `index.json` 看有哪些日期，再按需拉 `snapshots/` 下对应日期的文件；同一天的文件内容只在当天会变，过了那天就不会再改，可以放心按日期缓存。

## 本地手动跑一次

```bash
cd collector && npm ci && npm run collect
```

## 来源与版权

数值全部来自第三方统计站 wxq666.top，归该站所有；游戏内容归游戏官方所有。
本仓只做**个人学习用途**的每日快照留档，不做商业使用，不保证数据的准确性与持续可用。
如来源站方不希望被收录，请开 issue，会立即停止收集并删除数据。
