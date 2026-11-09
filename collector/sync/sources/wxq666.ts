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
//
// 2026-11-10 加「棋手 × 阵容」两类（组合建模线的契约，见共享笔记 data-contract-for-engine.md）：
//   GET /api/v1/lord-lineups?days=&segment=                         → 棋手 × 阵容 全表（约 155 行），每个窗口都抓
//   GET /api/v1/lords/<lordKey>/lineups/<lineupKey>?days=&segment=  → 详情（成员出场率、核心、成型回合、对阵、天赋），
//       只对 detailWindows（默认 [7]）里的窗口抓：一个窗口 155 个请求、原始单条 73KB，全窗口全量存不起（见 types.ts 的说明）。
//   详情单条失败不毁整天：跳过、记进 Snapshot.detailErrors，由收集器最后决定退出码。
//
// 英雄榜与阵容成员（2026-11-10 体验线要「英雄」标签有数据）：站上没有英雄榜接口，这里从详情里的棋子出场率
// 加权汇总出来——所以只有抓了详情的窗口（默认 7 天）才有 kind: 'hero' 的行和阵容成员，1/3 天窗口没有。
//   权重 = 该「棋手 × 阵容」占全部样本的份额（全表的 sampleShare）；英雄出场率 = Σ 份额 × 该棋子在这对里的出场率，
//   即「全部对局里有多少场上了这个棋子」；登顶率 / 前三率 / 平均名次 = 这个棋子上场的那些「棋手 × 阵容」的
//   对应指标，按（份额 × 出场率）加权。count 拿不到，null。

import type { SourceAdapter, Snapshot, StatRow, LineupRow, Window, LordLineupRow, LordLineupDetail } from './types'

const BASE = 'https://wxq666.top/api/v1'
const UA = { 'user-agent': 'wxq-helper sync (personal use)' }

/** 请求间隔：别把对方服务器打太快 */
const REQUEST_GAP_MS = 300
/** 失败重试次数（不含首次尝试），指数退避的起始等待 */
const RETRY_COUNT = 2
const RETRY_BASE_DELAY_MS = 500
/** 默认只对 7 天窗口抓「棋手 × 阵容」详情 */
const DEFAULT_DETAIL_WINDOWS = [7]

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

interface LordLineupApiRow {
  key: string
  lordKey: string
  lordName: string
  lineupKey: string
  lineupName: string
  lineupType?: string
  sampleShare: number
  top1Rate: number
  top3Rate: number
  averageRank?: number
  factions: string[]
}
interface LordLineupsResponse {
  data: LordLineupApiRow[]
  meta: WindowMeta
}

/** 详情接口的 data（只列用到的字段；其余原样忽略） */
interface LordLineupDetailApi {
  lord: { key: string; name: string }
  lineup: { key: string; name: string; type?: string; factions?: string[] }
  summary?: { sampleShare?: number; top1Rate?: number; top3Rate?: number }
  metrics?: { formedRate?: number; formationRound?: number; finalTopLevel?: number; maxRoundUseCards?: number }
  coreHeroes?: string[]
  matchups?: { items?: { opponentName: string; leadRate?: number }[] }
  heroStats?: {
    name: string
    appearRate?: number
    finalRate?: number
    avgLevel?: number
    mvpRate?: number
    topEquipment?: { name: string; n?: number; top1Rate?: number; top3Rate?: number }[]
  }[]
  talentSelections?: { name: string; usageRate?: number; top1Rate?: number; top3Rate?: number; n?: number }[]
}
interface LordLineupDetailResponse {
  data: LordLineupDetailApi
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

function buildLordLineupRow(row: LordLineupApiRow): LordLineupRow {
  return {
    lordId: row.lordKey,
    lordName: row.lordName,
    lineupId: row.lineupKey,
    lineupName: row.lineupName,
    camps: row.factions ?? [],
    appearanceRate: toRate(row.sampleShare),
    firstRate: toRate(row.top1Rate),
    top3Rate: toRate(row.top3Rate),
    avgPlacement: row.averageRank ?? null,
    raw: row,
  }
}

const numOrNull = (v: number | null | undefined): number | null => (v == null ? null : v)

/** 详情响应 → 精简记录（不留 raw，原因见 types.ts LordLineupDetail 的说明） */
function buildLordLineupDetail(d: LordLineupDetailApi): LordLineupDetail {
  return {
    lordId: d.lord.key,
    lordName: d.lord.name,
    lineupId: d.lineup.key,
    lineupName: d.lineup.name,
    camps: d.lineup.factions ?? [],
    share: toRate(d.summary?.sampleShare),
    firstRate: toRate(d.summary?.top1Rate),
    top3Rate: toRate(d.summary?.top3Rate),
    formedRate: toRate(d.metrics?.formedRate),
    formationRound: numOrNull(d.metrics?.formationRound),
    finalTopLevel: numOrNull(d.metrics?.finalTopLevel),
    maxRoundUseCards: numOrNull(d.metrics?.maxRoundUseCards),
    coreHeroes: d.coreHeroes ?? [],
    matchups: (d.matchups?.items ?? []).map((m) => ({ opponent: m.opponentName, leadRate: toRate(m.leadRate) })),
    heroes: (d.heroStats ?? []).map((h) => ({
      name: h.name,
      appearRate: toRate(h.appearRate),
      finalRate: toRate(h.finalRate),
      avgLevel: numOrNull(h.avgLevel),
      mvpRate: toRate(h.mvpRate),
      topEquipment: (h.topEquipment ?? []).map((e) => ({ name: e.name, n: numOrNull(e.n), top1Rate: toRate(e.top1Rate), top3Rate: toRate(e.top3Rate) })),
    })),
    talents: (d.talentSelections ?? []).map((t) => ({ name: t.name, usageRate: toRate(t.usageRate), top1Rate: toRate(t.top1Rate), top3Rate: toRate(t.top3Rate), n: numOrNull(t.n) })),
  }
}

/** 详情按（棋手×阵容）对上全表行拿权重；对不上（全表没这一行）按 0 权重忽略 */
function detailWeights(details: LordLineupDetail[], rows: LordLineupRow[]): { d: LordLineupDetail; w: number; row: LordLineupRow | undefined }[] {
  const byKey = new Map(rows.map((r) => [`${r.lordId}|${r.lineupId}`, r]))
  return details.map((d) => {
    const row = byKey.get(`${d.lordId}|${d.lineupId}`)
    return { d, w: row?.appearanceRate ?? 0, row }
  })
}

const round4 = (x: number) => Math.round(x * 10000) / 10000

/**
 * 从详情汇总英雄榜（kind: 'hero'）。纯函数，导出便于测试。
 * 没有一条详情、或权重全为 0 → 空数组（别造一张全 0 的榜）。
 */
export function deriveHeroRows(details: LordLineupDetail[], rows: LordLineupRow[]): StatRow[] {
  const items = detailWeights(details, rows).filter((x) => x.w > 0)
  const totalW = items.reduce((n, x) => n + x.w, 0)
  if (!totalW) return []
  const acc = new Map<string, { appear: number; first: number; top3: number; place: number; placeW: number; aw: number; n: number }>()
  for (const { d, w, row } of items) {
    for (const h of d.heroes) {
      if (h.appearRate == null) continue
      const a = acc.get(h.name) ?? { appear: 0, first: 0, top3: 0, place: 0, placeW: 0, aw: 0, n: 0 }
      const aw = w * h.appearRate
      a.appear += aw
      a.aw += aw
      a.first += aw * (d.firstRate ?? row?.firstRate ?? 0)
      a.top3 += aw * (d.top3Rate ?? row?.top3Rate ?? 0)
      if (row?.avgPlacement != null) { a.place += aw * row.avgPlacement; a.placeW += aw }
      a.n++
      acc.set(h.name, a)
    }
  }
  const out: StatRow[] = []
  for (const [name, a] of acc) {
    if (!a.aw) continue
    out.push({
      kind: 'hero',
      sourceId: `hero:${name}`,          // 站上没有英雄 id，用名字当 id
      name,
      appearanceRate: round4(a.appear / totalW),
      firstRate: round4(a.first / a.aw),
      top3Rate: round4(a.top3 / a.aw),
      avgPlacement: a.placeW ? round4(a.place / a.placeW) : null,
      count: null,
      raw: { derivedFrom: 'lord-lineup-details', pairs: a.n },   // 不是站上原始行：标明是从几对棋手×阵容详情汇总的
    })
  }
  return out.sort((x, y) => (y.appearanceRate ?? 0) - (x.appearanceRate ?? 0))
}

/** 阵容成员里只留加权出场率不低于这个值的棋子（9 个人里最后几个是 20–40% 的可选位，不算成员） */
const MEMBER_MIN_APPEAR = 0.5

/**
 * 从详情汇总每套阵容（按站上阵容名）的成员：各棋手版本按份额加权的棋子出场率 ≥ MEMBER_MIN_APPEAR 的留下，按出场率降序。
 * 返回 阵容名 → 成员；没详情的阵容不在结果里（调用方保持 members 为 null）。
 */
export function deriveLineupMembers(details: LordLineupDetail[], rows: LordLineupRow[]): Map<string, NonNullable<LineupRow['members']>> {
  const byLineup = new Map<string, { d: LordLineupDetail; w: number }[]>()
  for (const x of detailWeights(details, rows)) {
    const arr = byLineup.get(x.d.lineupName)
    const item = { d: x.d, w: x.w > 0 ? x.w : 1e-9 }
    if (arr) arr.push(item)
    else byLineup.set(x.d.lineupName, [item])
  }
  const out = new Map<string, NonNullable<LineupRow['members']>>()
  for (const [name, items] of byLineup) {
    const totalW = items.reduce((n, x) => n + x.w, 0)
    const appear = new Map<string, number>()
    for (const x of items) for (const h of x.d.heroes) appear.set(h.name, (appear.get(h.name) ?? 0) + x.w * (h.appearRate ?? 0))
    const members = [...appear]
      .map(([hero, v]) => ({ hero, rate: v / totalW }))
      .filter((m) => m.rate >= MEMBER_MIN_APPEAR)
      .sort((a, b) => b.rate - a.rate)
      .map((m) => ({ heroId: m.hero, heroName: m.hero }))
    if (members.length) out.set(name, members)
  }
  return out
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

/**
 * 抓一个（天数 × 段位）窗口：lords、lineups、lord-lineups 各一次请求，间隔 REQUEST_GAP_MS；
 * withDetails 时再对全表每一行抓一次详情（约 155 个请求）。
 */
async function fetchWindow(days: 1 | 3 | 7, segmentKey: string, fetchFn: typeof fetch, pace: number, withDetails: boolean): Promise<Snapshot> {
  const q = `days=${days}&segment=${segmentKey}`
  await sleep(REQUEST_GAP_MS * pace)
  const lords = await fetchJsonWithRetry<LordsResponse>(`${BASE}/lords?${q}`, fetchFn, pace)

  await sleep(REQUEST_GAP_MS * pace)
  const lineups = await fetchJsonWithRetry<LineupsResponse>(`${BASE}/lineups?${q}`, fetchFn, pace)

  await sleep(REQUEST_GAP_MS * pace)
  const lordLineups = await fetchJsonWithRetry<LordLineupsResponse>(`${BASE}/lord-lineups?${q}`, fetchFn, pace)

  const details: LordLineupDetail[] = []
  const detailErrors: string[] = []
  if (withDetails) {
    for (const row of lordLineups.data) {
      await sleep(REQUEST_GAP_MS * pace)
      const url = `${BASE}/lords/${row.lordKey}/lineups/${row.lineupKey}?${q}`
      try {
        const res = await fetchJsonWithRetry<LordLineupDetailResponse>(url, fetchFn, pace)
        details.push(buildLordLineupDetail(res.data))
      } catch (e) {
        // 单条详情失败不毁整天：跳过并记下，收集器最后据此决定退出码
        detailErrors.push((e as Error).message)
      }
    }
  }

  const lordLineupRows = lordLineups.data.map(buildLordLineupRow)
  const stats = lords.data.map(buildStatRow)
  const lineupRows = lineups.data.map(buildLineupRow)
  if (withDetails && details.length) {
    // 英雄榜与阵容成员都从详情汇总（站上没有这两样的接口）
    stats.push(...deriveHeroRows(details, lordLineupRows))
    const members = deriveLineupMembers(details, lordLineupRows)
    for (const l of lineupRows) l.members = members.get(l.name) ?? null
  }

  return {
    window: buildWindow(days, segmentKey, lords.meta),
    stats,
    lineups: lineupRows,
    meta: lords.meta,
    lordLineups: lordLineupRows,
    ...(withDetails ? { lordLineupDetails: details } : {}),
    ...(detailErrors.length ? { detailErrors } : {}),
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

    const detailWindows = opts?.detailWindows ?? DEFAULT_DETAIL_WINDOWS

    const snapshots: Snapshot[] = []
    for (const days of availableDayOptions) {
      for (const segment of availableSegments) {
        snapshots.push(await fetchWindow(days, segment.key, fetchFn, pace, detailWindows.includes(days)))
      }
    }
    return snapshots
  },
}
