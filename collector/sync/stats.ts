// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// 公共统计数据的收集器：跑所有已注册的数据源适配器，把快照落成文件。
//
// 两种输出模式：
//   1) 不带参数（开发用）：npm run sync:stats
//      合并进 public/data/stats-snapshot.json（一个 Snapshot[]），按「来源 × 窗口 × 段位 × 北京日期」去重：
//      同一天再跑一次就覆盖那一天的，不同天的追加。
//   2) --out <目录>（数据仓用，GitHub Actions 每天跑一次）：npx tsx sync/stats.ts --out ~/repos/wxq-data
//      每天一个文件，目录结构：
//        snapshots/YYYY-MM-DD.json   当天全部快照（{ date, generatedAt, snapshots }）
//        latest.json                 最新一天那份（同一形状，客户端平时只拉这一个）
//        index.json                  有哪些日期、每天的来源/窗口/段位/行数、生成时间（画 30 天曲线时先拉它）
//      日期用北京自然日；同一天重复跑会和当天已有文件合并（同键覆盖），不会产生第二份。
//
// 这个文件被复制到公开数据仓 aifyus/wxq-data 的 collector/ 下独立运行，所以它只许依赖
// sync/sources/{types,index,wxq666}.ts 和 tsx，不许 import 本仓其它东西。改动请两边同步。
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { adapters } from './sources/index.ts'
import type { Snapshot } from './sources/types.ts'

const DEV_OUT = join(import.meta.dirname, '..', 'public', 'data', 'stats-snapshot.json')

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

/** snapshots/YYYY-MM-DD.json 与 latest.json 的形状 */
export interface DayFile {
  /** 北京日期 YYYY-MM-DD */
  date: string
  /** 这份文件最后一次生成的时刻（ISO）。客户端「数据更新于」显示的就是它 */
  generatedAt: string
  snapshots: Snapshot[]
}

/** index.json 里每一天的概要 */
export interface IndexDay {
  date: string
  generatedAt: string
  /** 这天有哪些来源 / 窗口 / 段位 */
  sources: string[]
  windows: number[]
  segments: string[]
  /** 快照个数、榜单行数、阵容条数 */
  snapshots: number
  rows: number
  lineups: number
  /** 相对数据仓根的路径，客户端直接拼 raw 地址拉 */
  file: string
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

/** 从一组 DayFile 生成 index（纯函数，便于测试） */
export function buildIndex(dayFiles: DayFile[], generatedAt: string): IndexFile {
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
      file: `snapshots/${f.date}.json`,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
  return { generatedAt, latest: days.length ? days[days.length - 1].date : null, days }
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null
}

/**
 * 把新抓到的快照写进数据仓目录（纯文件操作，不抓网）。返回写了哪些日期。
 * - 新快照按北京日期分桶，每天和已有的当天文件合并（同键覆盖）；
 * - index.json 从目录里全部日文件重新生成，而不是增量改——文件就是真相，索引只是派生；
 * - latest.json 复制 index 里最新一天的那份。
 */
export function writeRepo(root: string, fresh: Snapshot[], now = new Date().toISOString()): string[] {
  const dir = join(root, 'snapshots')
  mkdirSync(dir, { recursive: true })
  const touched: string[] = []
  for (const [date, snaps] of groupByDay(fresh)) {
    const path = join(dir, `${date}.json`)
    const old = readJson<DayFile>(path)
    const file: DayFile = { date, generatedAt: now, snapshots: merge(old?.snapshots ?? [], snaps) }
    writeFileSync(path, JSON.stringify(file))
    touched.push(date)
  }
  const all = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => readJson<DayFile>(join(dir, f))!)
  const index = buildIndex(all, now)
  writeFileSync(join(root, 'index.json'), JSON.stringify(index, null, 2))
  if (index.latest) {
    const latest = all.find((f) => f.date === index.latest)!
    writeFileSync(join(root, 'latest.json'), JSON.stringify(latest))
  }
  return touched
}

// ======================= 命令行入口 =======================

function parseArgs(argv: string[]): { out: string | null } {
  const i = argv.indexOf('--out')
  if (i === -1) return { out: null }
  const out = argv[i + 1]
  if (!out || out.startsWith('--')) throw new Error('--out 后面要跟目录')
  return { out }
}

async function collect(): Promise<{ fresh: Snapshot[]; failures: string[] }> {
  const fresh: Snapshot[] = []
  const failures: string[] = []
  for (const a of adapters) {
    try {
      const snaps = await a.fetchAll()
      fresh.push(...snaps)
      console.log(`${a.source}：${snaps.length} 个快照，${snaps.reduce((n, s) => n + s.stats.length, 0)} 行，${snaps.reduce((n, s) => n + s.lineups.length, 0)} 条阵容`)
    } catch (e) {
      failures.push(`${a.source}：${(e as Error).message}`)
    }
  }
  return { fresh, failures }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2))
  const { fresh, failures } = await collect()

  if (out) {
    // 一个来源都没抓到就别写：否则会生成一份空的「今天」，看起来像成功
    if (fresh.length) {
      const dates = writeRepo(out, fresh)
      console.log(`写入 ${out}：日期 ${dates.join(', ')}，已重建 index.json / latest.json`)
    }
  } else {
    const existing = readJson<Snapshot[]>(DEV_OUT) ?? []
    const merged = merge(existing, fresh)
    mkdirSync(join(DEV_OUT, '..'), { recursive: true })
    writeFileSync(DEV_OUT, JSON.stringify(merged))
    console.log(`写入 ${DEV_OUT}：共 ${merged.length} 个快照，覆盖 ${groupByDay(merged).size} 天`)
  }

  // 失败不吞：有来源失败就非零退出，让定时任务变红
  if (failures.length) {
    console.error('失败的来源：\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) main()
