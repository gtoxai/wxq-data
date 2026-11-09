// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// wxq666.top 数据源：万象大赛「王者」段位的棋手（lord）与阵容（lineup）榜单。
// 接口分三个：
//   GET /api/v1/meta                       → 当前可用的天数窗口（1/3/7）与段位列表（segment）
//   GET /api/v1/lords?days=&segment=       → 该窗口 + 段位下的棋手榜
//   GET /api/v1/lineups?days=&segment=     → 该窗口 + 段位下的阵容榜
// 三个接口返回体都是 { data: [...], meta: {...} }（meta 只在 /meta 接口里是顶层字段，
// 不是包在 data 里；这里按实测取值，不是猜的——2026-11-09 实测过，见任务说明）。
// lords/lineups 响应里的 meta 才带这次窗口真正用到的 dateStart/dateEnd/rulesetVersion
// （同一个 days 数字，换 segment 统计区间会不一样，不能只信 /meta 接口那份全局 meta）。
//
// 百分比字段（sampleShare/top1Rate/top3Rate）来源是 0–100 的数，这里统一换成 0–1，
// 和 StatRow/LineupRow 的约定对齐。averageRank 直接映射成 avgPlacement；
// 两个接口都没有「场次」字段，count 统一填 null。

import type { SourceAdapter, Snapshot, StatRow, LineupRow, Window } from './types'

const BASE = 'https://wxq666.top/api/v1'
const UA = { 'user-agent': 'wxq-helper sync (personal use)' }

/** 请求间隔：别把对方服务器打太快 */
const REQUEST_GAP_MS = 300
/** 失败重试次数（不含首次尝试），指数退避的起始等待 */
const RETRY_COUNT = 2
const RETRY_BASE_DELAY_MS = 500

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** /api/v1/meta 的 data 字段里，fetchAll 要用到的部分 */
interface MetaSegment {
  key: string
  name: string
  available?: boolean
}
interface MetaData {
  days: 1 | 3 | 7
  availableDayOptions: (1 | 3 | 7)[]
  availableSegments: MetaSegment[]
}
interface MetaResponse {
  data: MetaData
}

/** lords / lineups 接口共享的那份「这次窗口统计信息」meta（样本量、阈值、时间范围…） */
interface WindowMeta {
  days: number
  dateStart: string
  dateEnd: string
  generatedAt: string
  rulesetVersion: string
  segmentKey: string
  [key: string]: unknown
}

interface LordApiRow {
  key: string
  name: string
  avatarUrl: string
  sampleShare: number
  top1Rate: number
  top3Rate: number
  averageRank: number
}
interface LordsResponse {
  data: LordApiRow[]
  meta: WindowMeta
}

interface LineupApiRow {
  key: string
  name: string
  type: string
  sampleShare: number
  top1Rate: number
  top3Rate: number
  factions: string[]
  averageRank?: number
}
interface LineupsResponse {
  data: LineupApiRow[]
  meta: WindowMeta
}

/** 带重试的 fetch + JSON 解析；失败（网络错误或非 2xx）按指数退避重试 RETRY_COUNT 次，
 *  仍失败就抛错，错误消息里带上出问题的 URL。 */
async function fetchJsonWithRetry<T>(url: string, fetchFn: typeof fetch, pace = 1): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await fetchFn(url, { headers: UA })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return (await res.json()) as T
    } catch (e) {
      lastError = e
      if (attempt < RETRY_COUNT) {
        await sleep(RETRY_BASE_DELAY_MS * pace * 2 ** attempt)
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`wxq666 请求失败（已重试 ${RETRY_COUNT} 次）：${url} — ${reason}`)
}

function toRate(percent: number | null | undefined): number | null {
  return percent == null ? null : percent / 100
}

function buildStatRow(row: LordApiRow): StatRow {
  return {
    kind: 'player',
    sourceId: row.key,
    name: row.name,
    appearanceRate: toRate(row.sampleShare),
    firstRate: toRate(row.top1Rate),
    top3Rate: toRate(row.top3Rate),
    avgPlacement: row.averageRank ?? null,
    count: null,
    raw: row,
  }
}

function buildLineupRow(row: LineupApiRow): LineupRow {
  return {
    sourceId: row.key,
    name: row.name,
    camps: row.factions,
    appearanceRate: toRate(row.sampleShare),
    firstRate: toRate(row.top1Rate),
    top3Rate: toRate(row.top3Rate),
    avgPlacement: row.averageRank ?? null,
    count: null,
    members: null,
    raw: row,
  }
}

function buildWindow(days: 1 | 3 | 7, segmentKey: string, windowMeta: WindowMeta): Window {
  return {
    source: 'wxq666',
    windowDays: days,
    segment: segmentKey,
    version: windowMeta.rulesetVersion ?? null,
    gameType: 'wanxiang',
    fetchedAt: new Date().toISOString(),
    dateStart: windowMeta.dateStart ?? null,
    dateEnd: windowMeta.dateEnd ?? null,
  }
}

/** 抓一个（天数 × 段位）窗口：lords 和 lineups 各一次请求，间隔 REQUEST_GAP_MS */
async function fetchWindow(days: 1 | 3 | 7, segmentKey: string, fetchFn: typeof fetch, pace: number): Promise<Snapshot> {
  await sleep(REQUEST_GAP_MS * pace)
  const lordsUrl = `${BASE}/lords?days=${days}&segment=${segmentKey}`
  const lords = await fetchJsonWithRetry<LordsResponse>(lordsUrl, fetchFn, pace)

  await sleep(REQUEST_GAP_MS * pace)
  const lineupsUrl = `${BASE}/lineups?days=${days}&segment=${segmentKey}`
  const lineups = await fetchJsonWithRetry<LineupsResponse>(lineupsUrl, fetchFn, pace)

  return {
    window: buildWindow(days, segmentKey, lords.meta),
    stats: lords.data.map(buildStatRow),
    lineups: lineups.data.map(buildLineupRow),
    meta: lords.meta,
  }
}

export const wxq666: SourceAdapter = {
  source: 'wxq666',

  async fetchAll(opts) {
    const fetchFn = opts?.fetch ?? fetch
    // paceMs 是基准毫秒：默认 300 → 系数 1；测试传 0 → 全部不等
    const pace = (opts?.paceMs ?? REQUEST_GAP_MS) / REQUEST_GAP_MS

    const metaUrl = `${BASE}/meta`
    const meta = await fetchJsonWithRetry<MetaResponse>(metaUrl, fetchFn, pace)
    const { availableDayOptions, availableSegments } = meta.data

    const snapshots: Snapshot[] = []
    for (const days of availableDayOptions) {
      for (const segment of availableSegments) {
        snapshots.push(await fetchWindow(days, segment.key, fetchFn, pace))
      }
    }
    return snapshots
  },
}
