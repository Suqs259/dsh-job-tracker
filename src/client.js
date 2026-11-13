/**
 * job-tracker REST API client: session login, cookie retention, and one
 * re-login retry on 401, so a long-lived dsh process survives expiry.
 * @module dsh-job-tracker/client
 */

const env = process.env

function resolveOptions(options) {
  return {
    baseUrl: String(options.baseUrl ?? env.DSH_JOB_TRACKER_URL ?? 'http://127.0.0.1:5000').replace(/\/+$/, ''),
    username: options.username ?? env.DSH_JOB_TRACKER_USERNAME,
    password: options.password ?? env.DSH_JOB_TRACKER_PASSWORD,
  }
}

/**
 * Create a client bound to one job-tracker deployment.
 * @param options - { baseUrl?, username?, password? }; each falls back to
 *   DSH_JOB_TRACKER_URL / DSH_JOB_TRACKER_USERNAME / DSH_JOB_TRACKER_PASSWORD.
 * @returns { stats, list, add } backed by the job-tracker REST API.
 */
export function createClient(options = {}) {
  const { baseUrl, username, password } = resolveOptions(options)
  let cookie = null

  async function login() {
    let res
    try {
      res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
    } catch (error) {
      throw new Error(`无法连接 job-tracker（${baseUrl}）：${error?.message ?? error}。请确认服务已启动（python run.py）。`)
    }
    if (res.status === 401) {
      throw new Error(
        `job-tracker 登录被拒绝（用户名或密码错误）。请检查 DSH_JOB_TRACKER_USERNAME / DSH_JOB_TRACKER_PASSWORD`,
      )
    }
    if (!res.ok) {
      throw new Error(`job-tracker 登录失败（HTTP ${res.status}）：服务是否已启动？`)
    }
    const jar = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    cookie = jar.map((value) => value.split(';', 1)[0]).join('; ')
    if (cookie === '') throw new Error('job-tracker 登录成功但未返回会话 Cookie')
  }

  async function request(method, path, body, retried = false) {
    if (cookie === null) await login()
    let res
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new Error(`无法连接 job-tracker（${baseUrl}）：${error?.message ?? error}。请确认服务已启动（python run.py）。`)
    }
    if (res.status === 401) {
      cookie = null
      if (!retried) return request(method, path, body, true)
      throw new Error('job-tracker 会话在重新登录后仍被拒绝')
    }
    const text = await res.text()
    let data = null
    if (text !== '') { try { data = JSON.parse(text) } catch { data = null } }
    if (!res.ok) {
      throw new Error(`job-tracker ${method} ${path} 失败（HTTP ${res.status}）：${data?.error ?? text}`)
    }
    return data
  }

  return {
    /** Dashboard aggregates: totals, funnel, channel mix, 30-day trend. */
    stats: () => request('GET', '/api/stats'),

    /** Paged application list; empty params are dropped from the query string. */
    list: (params = {}) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) if (value) query.set(key, String(value))
      return request('GET', `/api/applications${query.size === 0 ? '' : `?${query}`}`)
    },

    /** Create one application record. */
    add: (record) => request('POST', '/api/applications', record),
  }
}
