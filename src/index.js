/**
 * dsh-job-tracker: connect a local job-tracker deployment (Flask + SQLite
 * application-tracker for campus recruiting) to DeepSeek Harness.
 *
 * Registers three slash commands — /job-stats, /job-list, /job-add — and one
 * model-callable tool `job_tracker`, all backed by the same REST client.
 * @module dsh-job-tracker
 */

import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createClient } from './client.js'

/** Cordis plugin name. */
export const name = 'job-tracker'
/** Services this plugin needs: the command registry and the tool registry. */
export const inject = ['commands', 'tools']

const STATUSES = ['已投递', '简历通过', '笔试', '一面', '二面', 'HR面', 'Offer', '已挂']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Today's date in the tracker's timezone, formatted YYYY-MM-DD. */
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.APP_TIMEZONE ?? 'Asia/Shanghai' })
    .format(new Date())
}

const USAGE = [
  '用法：/job-add 公司 | 岗位 | [城市] | [渠道] | [薪资] | [日期 YYYY-MM-DD] | [备注]',
  '示例：/job-add 视源股份 | 数据开发 | 广州 | 官网 | 14-18K | 2026-11-13 | HR 说本周安排笔试',
  '公司、岗位必填；日期缺省为今天，状态默认「已投递」。',
].join('\n')

/** Format the /api/stats payload as one human-readable block. */
function formatStats(data) {
  const lines = [
    `总投递 ${data.total} · 进入笔面 ${data.interview}（${data.interview_rate}%）· Offer ${data.offers}（${data.offer_rate}%）`,
  ]
  const funnel = STATUSES.filter((status) => (data.by_status?.[status] ?? 0) > 0)
    .map((status) => `${status} ${data.by_status[status]}`)
    .join('，')
  if (funnel !== '') lines.push(`阶段分布：${funnel}`)
  const channels = (data.by_channel ?? [])
    .map((row) => `${row.name} ${row.count}（${Math.round((row.count / data.total) * 100)}%）`)
    .join('，')
  if (channels !== '') lines.push(`渠道分布：${channels}`)
  const recent = (data.trend ?? []).reduce((sum, day) => sum + day.count, 0)
  lines.push(`近 30 天投递 ${recent} 份`)
  return lines.join('\n')
}

/** Format one page of the application list. */
function formatList(data) {
  if (data.total === 0) return '还没有投递记录，用 /job-add 记第一份。'
  const header = `共 ${data.total} 条（第 ${data.page}/${data.pages} 页，每页 ${data.page_size} 条）：`
  const rows = data.items.map((item, index) => {
    const city = item.city === '' ? '' : ` · ${item.city}`
    const salary = item.salary === '' ? '' : ` · ${item.salary}`
    return `${data.page_size * (data.page - 1) + index + 1}. ${item.company} · ${item.position}${city}${salary} · ${item.status} · ${item.apply_date}`
  })
  return [header, ...rows].join('\n')
}

/** Parse "/job-add a | b | c..." into one application record. */
function parseAddInput(rawInput) {
  const parts = rawInput.split('|').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length < 2) return { error: `公司、岗位必填。\n${USAGE}` }
  const [company, position, city = '', channel = '', salary = '', applyDate = '', note = ''] = parts
  if (applyDate !== '' && !DATE_RE.test(applyDate)) {
    return { error: `日期格式应为 YYYY-MM-DD，收到「${applyDate}」。\n${USAGE}` }
  }
  return {
    record: {
      company,
      position,
      city,
      channel,
      salary,
      status: '已投递',
      apply_date: applyDate === '' ? today() : applyDate,
      note,
    },
  }
}

/** Wrap one handler so every failure surfaces as a readable command error. */
function guarded(handler) {
  return async (invocation) => {
    if (invocation.signal.aborted) return { kind: 'error', text: '已取消。' }
    try {
      return await handler(invocation)
    } catch (error) {
      return { kind: 'error', text: String(error?.message ?? error) }
    }
  }
}

/**
 * Register the three commands and the tool against one shared client.
 * @param ctx - Cordis context carrying the `commands` and `tools` services.
 * @param config - { baseUrl?, username?, password? } from the profile patch
 *   row; each entry may also come from the DSH_JOB_TRACKER_* environment.
 */
export function apply(ctx, config = {}) {
  const client = createClient(config)

  const handlers = [
    {
      definitionId: CommandDefinitionId('dsh-job-tracker/stats'),
      name: 'job-stats',
      description: 'Show job-tracker dashboard totals',
      handler: guarded(async () => {
        const data = await client.stats()
        return { kind: 'success', text: formatStats(data) }
      }),
    },
    {
      definitionId: CommandDefinitionId('dsh-job-tracker/list'),
      name: 'job-list',
      description: 'List job applications (optional keyword argument)',
      handler: guarded(async (invocation) => {
        const keyword = invocation.rawInput.trim()
        const data = await client.list({ keyword, page_size: 20 })
        return { kind: 'success', text: formatList(data) }
      }),
    },
    {
      definitionId: CommandDefinitionId('dsh-job-tracker/add'),
      name: 'job-add',
      description: 'Record one job application: /job-add 公司 | 岗位 | ...',
      handler: guarded(async (invocation) => {
        const { record, error } = parseAddInput(invocation.rawInput)
        if (error !== undefined) return { kind: 'error', text: error }
        const created = await client.add(record)
        return {
          kind: 'success',
          text: `已记录第 ${created.id} 条：${created.company} · ${created.position} · ${created.status} · ${created.apply_date}`,
        }
      }),
    },
  ]

  // Commands retire before registration unwinds, mirroring the official
  // command-compact lifecycle: composite teardown is LIFO.
  ctx.effect(function* () {
    for (const handler of handlers) yield ctx.commands.register(handler)
  }, 'dsh-job-tracker commands')

  ctx.tools.register(defineTool({
    name: 'job_tracker',
    description:
      'Manage the user\'s campus-recruiting applications in their local job-tracker service. '
      + 'action "stats" returns dashboard aggregates; "list" searches applications (optional keyword); '
      + '"add" records a new application. For "add", company and position are required, '
      + 'status must be one of 已投递/简历通过/笔试/一面/二面/HR面/Offer/已挂 (default 已投递), '
      + 'and apply_date must be YYYY-MM-DD (default today).',
    parameters: {
      action: {
        type: 'string',
        enum: ['stats', 'list', 'add'],
        required: true,
        description: 'Which operation to run.',
      },
      company: { type: 'string', description: 'add: company name.' },
      position: { type: 'string', description: 'add: position title.' },
      city: { type: 'string', description: 'add: city, optional.' },
      channel: { type: 'string', description: 'add: application channel such as 官网/BOSS直聘/内推, optional.' },
      salary: { type: 'string', description: 'add: salary range, optional.' },
      status: { type: 'string', description: 'add: status, default 已投递.' },
      apply_date: { type: 'string', description: 'add: date YYYY-MM-DD, default today.' },
      note: { type: 'string', description: 'add: free-form note, optional.' },
      keyword: { type: 'string', description: 'list: search by company/position/note, optional.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'Human-readable operation result.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('job_tracker call was cancelled')
      if (args.action === 'stats') {
        const data = await client.stats()
        return { summary: formatStats(data) }
      }
      if (args.action === 'list') {
        const data = await client.list({ keyword: args.keyword, page_size: 20 })
        return { summary: formatList(data) }
      }
      if (!args.company || !args.position) {
        throw new Error('action "add" requires company and position')
      }
      if (args.status !== undefined && !STATUSES.includes(args.status)) {
        throw new Error(`status must be one of: ${STATUSES.join('/')}`)
      }
      if (args.apply_date !== undefined && !DATE_RE.test(args.apply_date)) {
        throw new Error('apply_date must be YYYY-MM-DD')
      }
      const created = await client.add({
        company: args.company,
        position: args.position,
        city: args.city ?? '',
        channel: args.channel ?? '',
        salary: args.salary ?? '',
        status: args.status ?? '已投递',
        apply_date: args.apply_date ?? today(),
        note: args.note ?? '',
      })
      return {
        summary: `已记录第 ${created.id} 条：${created.company} · ${created.position} · ${created.status} · ${created.apply_date}`,
      }
    },
  }))
}
