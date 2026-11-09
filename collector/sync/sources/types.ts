// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// 数据源的统一形状。每个来源（wxq666、datawxq）实现 fetchAll()，返回同一种快照记录，
// 由 Edge Function / 本地脚本写进 Supabase 的 stat_* 表。
// 原则：原始字段不丢（raw），统一字段只做「能对齐的那几个」——出场率、登顶率、前三率、平均名次、场次。

export type Source = 'wxq666' | 'datawxq'
export type GameType = 'wanxiang' | 'diamond'   // 万象大赛 / 钻石狂潮（datawxq 的 gameType 2 / 4）

/** 一次抓取的上下文：窗口、段位、版本。没有的填 null。 */
export interface Window {
  source: Source
  windowDays: 1 | 3 | 7
  segment: string | null       // wxq666: king-1000 / king-5000；datawxq 无段位 → null
  version: string | null       // datawxq: v261106a…；wxq666 → rulesetVersion
  gameType: GameType
  fetchedAt: string            // ISO 时间，抓取时刻
  dateStart?: string | null    // 来源声明的统计起止日（有就填）
  dateEnd?: string | null
}

/** 统一的榜单行：棋手 / 英雄 / 装备 / 天赋 都是这一种 */
export interface StatRow {
  kind: 'player' | 'hero' | 'equipment' | 'talent'
  sourceId: string             // 来源里的 id（wxq666 的 lord-xxx；datawxq 的数字 id）
  name: string                 // 来源里的名字（官方写法）
  appearanceRate: number | null  // 出场/登场率，0–1
  firstRate: number | null       // 登顶率，0–1
  top3Rate: number | null        // 前三率，0–1
  avgPlacement: number | null    // 平均名次
  count: number | null           // 场次
  raw: unknown                   // 来源原始对象，原样保留
}

/** 阵容行：wxq666 只有名字和阵营；datawxq 带成员 */
export interface LineupRow {
  sourceId: string
  name: string
  camps: string[]                // 中文阵营名，照来源
  appearanceRate: number | null
  firstRate: number | null
  top3Rate: number | null
  avgPlacement: number | null
  count: number | null
  members: { heroId: string; heroName?: string; stars?: number; equipIds?: string[] }[] | null
  raw: unknown
}

/** 一个来源一次抓取的全部产物 */
export interface Snapshot {
  window: Window
  stats: StatRow[]
  lineups: LineupRow[]
  meta: unknown                  // 来源的 meta 原样（样本量、阈值等）
}

/** fetchAll 的选项：注入 fetch（测试用）；paceMs 是请求间隔和重试退避的基准毫秒，测试传 0 就不等 */
export interface FetchOpts {
  fetch?: typeof fetch
  paceMs?: number
}

export interface SourceAdapter {
  source: Source
  /** 抓这个来源在所有要抓的窗口下的快照；单个窗口失败要抛错带上窗口信息，不要吞 */
  fetchAll(opts?: FetchOpts): Promise<Snapshot[]>
}
