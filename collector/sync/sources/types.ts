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

/**
 * 「棋手 × 阵容」一行（wxq666 的 /api/v1/lord-lineups，每个窗口约 155 行）。
 * appearanceRate 是这对组合占**全部样本**的份额（不是占该棋手对局的份额——那个在详情的 share 里）。
 */
export interface LordLineupRow {
  lordId: string
  lordName: string
  lineupId: string
  lineupName: string
  camps: string[]
  appearanceRate: number | null
  firstRate: number | null
  top3Rate: number | null
  avgPlacement: number | null
  raw: unknown
}

/**
 * 「棋手 × 阵容」详情（wxq666 的 /api/v1/lords/<lord>/lineups/<lineup>）。
 * ⚠️ 这是唯一**不保留 raw** 的记录：原始响应单条 73KB（装备图标、描述、至高决策…），一天两个段位 310 条就是 22MB，
 * 数据仓存不起；这里只留引擎和复盘要用的字段，精简到每条 3KB 左右。要加字段改这里的 builder，不要恢复 raw。
 * 率都已换成 0–1；等级、回合是原数。
 */
export interface LordLineupDetail {
  lordId: string
  lordName: string
  lineupId: string
  lineupName: string
  camps: string[]
  /** 这套阵容占该棋手全部对局的比例（summary.sampleShare） */
  share: number | null
  firstRate: number | null
  top3Rate: number | null
  /** 成型率 / 成型回合 / 终局平均最高等级 / 用牌峰值（metrics） */
  formedRate: number | null
  formationRound: number | null
  finalTopLevel: number | null
  maxRoundUseCards: number | null
  coreHeroes: string[]
  /** 对各阵容（站上阵容名）的领先率 */
  matchups: { opponent: string; leadRate: number | null }[]
  /** 成员棋子：出场率、终局在场率、平均等级、MVP 率；热门装备只留名字和表现 */
  heroes: {
    name: string
    appearRate: number | null
    finalRate: number | null
    avgLevel: number | null
    mvpRate: number | null
    topEquipment: { name: string; n: number | null; top1Rate: number | null; top3Rate: number | null }[]
  }[]
  /** 天赋选择：名字、选用率、表现、样本数 */
  talents: { name: string; usageRate: number | null; top1Rate: number | null; top3Rate: number | null; n: number | null }[]
}

/** 一个来源一次抓取的全部产物 */
export interface Snapshot {
  window: Window
  stats: StatRow[]
  lineups: LineupRow[]
  meta: unknown                  // 来源的 meta 原样（样本量、阈值等）
  /** 棋手 × 阵容 全表（2026-11-10 加；老快照没有这个字段，读的时候用 ?? []） */
  lordLineups?: LordLineupRow[]
  /** 棋手 × 阵容 详情（只对 FetchOpts.detailWindows 指定的窗口抓，默认只抓 7 天） */
  lordLineupDetails?: LordLineupDetail[]
  /** 详情单条失败（重试后仍失败）的记录；不为空时收集器最后非零退出，但数据照样写出 */
  detailErrors?: string[]
}

/**
 * fetchAll 的选项：注入 fetch（测试用）；paceMs 是请求间隔和重试退避的基准毫秒，测试传 0 就不等；
 * detailWindows 指定哪些窗口天数抓「棋手 × 阵容」详情，默认 [7]，传 [] 就不抓。
 */
export interface FetchOpts {
  fetch?: typeof fetch
  paceMs?: number
  detailWindows?: number[]
}

export interface SourceAdapter {
  source: Source
  /** 抓这个来源在所有要抓的窗口下的快照；单个窗口失败要抛错带上窗口信息，不要吞 */
  fetchAll(opts?: FetchOpts): Promise<Snapshot[]>
}
