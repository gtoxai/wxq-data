// ⚠️ 本文件来源于 wxq-helper 仓的 sync/ 目录（收集器在那边开发、测试），这里是运行副本。改动请两边同步。
// 适配器注册表：Edge Function（sync-stats）和本地脚本都从这里拿到所有数据源适配器。
// sync-stats 不必知道有哪些来源——它只遍历 adapters、对每个调 fetchAll()。
// 新来源：实现 SourceAdapter 后在这里加一行。
import type { SourceAdapter } from './types.ts'
import { wxq666 } from './wxq666.ts'

// 2026-11-09 业主定：现阶段只用 wxq666 一个数据源。datawxq 的适配器保留（sync/sources/datawxq.ts），
// 等针对它做专项研究（真实报文校对、IP 封禁）后再在这里加回来。
export const adapters: SourceAdapter[] = [wxq666]
