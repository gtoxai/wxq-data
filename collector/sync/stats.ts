// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// 公共统计数据的收集器：跑所有已注册的数据源适配器，把快照落成文件。
//
// 两种输出模式：
//   1) 不带参数（开发用）：npm run sync:stats
//      合并进 public/data/stats-snapshot.json（一个 Snapshot[]），按「来源 × 窗口 × 段位 × 北京日期」去重：
//      同一天再跑一次就覆盖那一天的，不同天的追加。
//   2) --out <目录>（数据仓用，GitHub Actions 每天跑一次）：npx tsx sync/stats.ts --out ~/repos/wxq-data
//      每天一个文件，目录结构：
//        snapshots/YYYY-MM-DD.json           当天全部快照（{ date, generatedAt, snapshots }），**不含**棋手×阵容详情
//        snapshots/YYYY-MM-DD.details.json   当天的棋手×阵容详情（{ date, generatedAt, details: [{ window, lordLineupDetails }] }）
//        latest.json / latest-details.json   最新一天的上面两份（客户端数据页只拉前者，选将页才拉后者）
//        index.json                          有哪些日期、每天的来源/窗口/段位/行数、生成时间（画 30 天曲线时先拉它）
//      为什么拆两份：详情一天约 2MB（装备、天赋明细），榜单只有 100 多 KB；数据页每次打开都要榜单、从不看详情，
//      放一起会让它白拉十几倍的数据。日期用北京自然日；同一天重复跑会和当天已有文件合并（同键覆盖），不会产生第二份。
//
// 这个文件被复制到公开数据仓 gtoxai/wxq-data 的 collector/ 下独立运行，所以它只许依赖
// sync/dayfile.ts、sync/sources/{types,index,wxq666}.ts 和 tsx，不许 import 本仓其它东西。改动请两边同步。
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { adapters } from './sources/index.ts'
import type { Snapshot } from './sources/types.ts'
import { beijingDate, merge, groupByDay, splitDetails, windowKey, buildIndex, type DayFile, type DetailsFile } from './dayfile.ts'

// 纯逻辑住在 dayfile.ts（浏览器端也要用）；这里转一手导出，测试和老引用不用改
export * from './dayfile.ts'

const DEV_OUT = join(import.meta.dirname, '..', 'public', 'data', 'stats-snapshot.json')

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
  for (const [date, daySnaps] of groupByDay(fresh)) {
    const { snapshots, details } = splitDetails(daySnaps)
    const path = join(dir, `${date}.json`)
    const old = readJson<DayFile>(path)
    const file: DayFile = { date, generatedAt: now, snapshots: merge(old?.snapshots ?? [], snapshots) }
    writeFileSync(path, JSON.stringify(file))
    if (details.length) {
      // 详情同一天重跑：按窗口键覆盖
      const dpath = join(dir, `${date}.details.json`)
      const oldD = readJson<DetailsFile>(dpath)
      const map = new Map((oldD?.details ?? []).map((d) => [windowKey(d.window), d]))
      for (const d of details) map.set(windowKey(d.window), d)
      const dfile: DetailsFile = { date, generatedAt: now, details: [...map.values()] }
      writeFileSync(dpath, JSON.stringify(dfile))
    }
    touched.push(date)
  }
  const names = readdirSync(dir)
  const all = names.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => readJson<DayFile>(join(dir, f))!)
  const allDetails = names.filter((f) => /^\d{4}-\d{2}-\d{2}\.details\.json$/.test(f)).map((f) => readJson<DetailsFile>(join(dir, f))!)
  const index = buildIndex(all, now, allDetails)
  writeFileSync(join(root, 'index.json'), JSON.stringify(index, null, 2))
  if (index.latest) {
    writeFileSync(join(root, 'latest.json'), JSON.stringify(all.find((f) => f.date === index.latest)!))
    const latestDetails = allDetails.find((f) => f.date === index.latest)
    if (latestDetails) writeFileSync(join(root, 'latest-details.json'), JSON.stringify(latestDetails))
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
      const sum = (f: (s: Snapshot) => number) => snaps.reduce((n, s) => n + f(s), 0)
      console.log(
        `${a.source}：${snaps.length} 个快照，${sum((s) => s.stats.length)} 行，${sum((s) => s.lineups.length)} 条阵容，` +
          `${sum((s) => s.lordLineups?.length ?? 0)} 行棋手×阵容，${sum((s) => s.lordLineupDetails?.length ?? 0)} 条详情`,
      )
      // 详情单条失败：数据已经在快照里（缺那几条），这里只汇总成失败项，让最后退出码非零
      const detailErrors = snaps.flatMap((s) => s.detailErrors ?? [])
      if (detailErrors.length) failures.push(`${a.source}：${detailErrors.length} 条详情抓取失败（数据已写出、缺这些条）\n    ` + detailErrors.join('\n    '))
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

  // 失败不吞：有来源整个失败、或有详情条目失败，都非零退出让定时任务变红——但数据在上面已经写出，
  // 工作流的提交步骤用 if: always() 把写出的部分照样提交，不让一条详情失败丢掉整天
  if (failures.length) {
    console.error('失败的来源：\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) main()
