// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// 数据仓文件的形状与纯逻辑：北京日期、去重合并、按天分桶、详情拆合、index 生成。
// 这个文件**不碰文件系统和网络**，浏览器端（src/data/stats.ts）和收集器（sync/stats.ts）共用；
// 带 node:fs 的写盘逻辑在 sync/stats.ts。它也是数据仓 collector/ 要复制的文件之一（改动两边同步）。
import type { Snapshot, Window, LordLineupDetail } from './sources/types.ts'

/** 北京自然日（YYYY-MM-DD） */
export function beijingDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

/** 去重键：来源 × 窗口天数 × 段位 × 玩法 × 北京日期 */
const keyOf = (s: Snapshot) => [s.window.source, s.window.windowDays, s.window.segment ?? '', s.window.gameType, beijingDate(s.window.fetchedAt)].join('|')

/** 合并：新快照覆盖同键旧快照，其余保留；按抓取时间排序 */
export function merge(existing: Snapshot[], fresh: Snapshot[]): Snapshot[] {
  const map = new Map(existing.map((s) => [keyOf(s), s]))
  for (const s of fresh) map.set(keyOf(s), s)
  return [...map.values()].sort((a, b) => a.window.fetchedAt.localeCompare(b.window.fetchedAt))
}

/** 按北京日期分桶 */
export function groupByDay(snaps: Snapshot[]): Map<string, Snapshot[]> {
  const out = new Map<string, Snapshot[]>()
  for (const s of snaps) {
    const d = beijingDate(s.window.fetchedAt)
    const arr = out.get(d)
    if (arr) arr.push(s)
    else out.set(d, [s])
  }
  return out
}

// ======================= 数据仓文件形状 =======================

/** snapshots/YYYY-MM-DD.json 与 latest.json 的形状。这里的 Snapshot 不带 lordLineupDetails（拆去了 details 文件） */
export interface DayFile {
  /** 北京日期 YYYY-MM-DD */
  date: string
  /** 这份文件最后一次生成的时刻（ISO）。客户端「数据更新于」显示的就是它 */
  generatedAt: string
  snapshots: Snapshot[]
}

/** 一个窗口的详情块：window 用来和 DayFile 里的快照对上（来源 × 天数 × 段位） */
export interface DetailBlock {
  window: Window
  lordLineupDetails: LordLineupDetail[]
  detailErrors?: string[]
}

/** snapshots/YYYY-MM-DD.details.json 与 latest-details.json 的形状 */
export interface DetailsFile {
  date: string
  generatedAt: string
  details: DetailBlock[]
}

/** 窗口键：来源 × 天数 × 段位 × 玩法（不含日期，用来在同一天里把详情块对回快照） */
export const windowKey = (w: Window) => [w.source, w.windowDays, w.segment ?? '', w.gameType].join('|')

/** 把一组快照拆成「不带详情的快照」和「详情块」。没抓详情的窗口不产生详情块 */
export function splitDetails(snaps: Snapshot[]): { snapshots: Snapshot[]; details: DetailBlock[] } {
  const snapshots: Snapshot[] = []
  const details: DetailBlock[] = []
  for (const s of snaps) {
    const { lordLineupDetails, detailErrors, ...rest } = s
    snapshots.push(rest)
    if (lordLineupDetails) details.push({ window: s.window, lordLineupDetails, ...(detailErrors ? { detailErrors } : {}) })
  }
  return { snapshots, details }
}

/** 反向：把详情块按窗口键合回快照（客户端选将页用）。对不上的详情块丢弃 */
export function mergeDetails(snaps: Snapshot[], details: DetailBlock[]): Snapshot[] {
  const byKey = new Map(details.map((d) => [windowKey(d.window), d]))
  return snaps.map((s) => {
    const d = byKey.get(windowKey(s.window))
    return d ? { ...s, lordLineupDetails: d.lordLineupDetails, ...(d.detailErrors ? { detailErrors: d.detailErrors } : {}) } : s
  })
}

/** index.json 里每一天的概要 */
export interface IndexDay {
  date: string
  generatedAt: string
  /** 这天有哪些来源 / 窗口 / 段位 */
  sources: string[]
  windows: number[]
  segments: string[]
  /** 快照个数、榜单行数、阵容条数、棋手×阵容行数、详情条数 */
  snapshots: number
  rows: number
  lineups: number
  lordLineups: number
  details: number
  /** 相对数据仓根的路径，客户端直接拼 raw 地址拉 */
  file: string
  /** 详情文件的路径；这天没抓详情就没有 */
  detailsFile?: string
}

/** index.json 的形状 */
export interface IndexFile {
  /** index 本身的生成时刻 */
  generatedAt: string
  /** 最新一天的日期（= latest.json 的 date）；一个都没有时 null */
  latest: string | null
  /** 按日期升序 */
  days: IndexDay[]
}

const uniqSorted = <T,>(xs: T[]) => [...new Set(xs)].sort()

/** 从一组 DayFile（和它们各自的 DetailsFile，可无）生成 index（纯函数，便于测试） */
export function buildIndex(dayFiles: DayFile[], generatedAt: string, detailFiles: DetailsFile[] = []): IndexFile {
  const detailsByDate = new Map(detailFiles.map((d) => [d.date, d]))
  const days: IndexDay[] = dayFiles
    .map((f) => ({
      date: f.date,
      generatedAt: f.generatedAt,
      sources: uniqSorted(f.snapshots.map((s) => s.window.source)),
      windows: uniqSorted(f.snapshots.map((s) => s.window.windowDays)),
      segments: uniqSorted(f.snapshots.map((s) => s.window.segment).filter((x): x is string => x != null)),
      snapshots: f.snapshots.length,
      rows: f.snapshots.reduce((n, s) => n + s.stats.length, 0),
      lineups: f.snapshots.reduce((n, s) => n + s.lineups.length, 0),
      lordLineups: f.snapshots.reduce((n, s) => n + (s.lordLineups?.length ?? 0), 0),
      details: (detailsByDate.get(f.date)?.details ?? []).reduce((n, d) => n + d.lordLineupDetails.length, 0),
      file: `snapshots/${f.date}.json`,
      ...(detailsByDate.has(f.date) ? { detailsFile: `snapshots/${f.date}.details.json` } : {}),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { generatedAt, latest: days.length ? days[days.length - 1].date : null, days }
}
