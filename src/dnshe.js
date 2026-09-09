/**
 * DNSHE API 客户端（Worker 共享模块）
 * 读取环境变量 DNSHE_ACCOUNTS（JSON 数组，每个账号含 name / X-API-Key / X-API-Secret）
 * 提供永久升级中心（好友助力）相关 API 调用。
 */
const DNSHE_BASE = 'https://api005.dnshe.com/index.php?m=domain_hub';

/**
 * 解析 DNSHE_ACCOUNTS 环境变量
 * @returns {Array<{name:string, X-API-Key:string, X-API-Secret:string}>}
 */
export function getAccounts(env) {
  const raw = env.DNSHE_ACCOUNTS || '';
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(a => a && a['X-API-Key'] && a['X-API-Secret']) : [];
  } catch (e) {
    console.error('DNSHE_ACCOUNTS parse error:', e.message);
    return [];
  }
}

/**
 * 调用 DNSHE API
 * 注意：list 类查询必须用 GET（query 参数），create/assist/cancel 写操作用 POST（JSON body）
 * 已内置：失败自动重试（525/5xx/网络错误，最多 2 次，间隔 800ms）
 * @param {object} account 账号对象
 * @param {string} endpoint 端点（subdomains / dns_records / quota / permanent_upgrade ...）
 * @param {string} action 动作（list / create / assist / cancel ...）
 * @param {object} [query] GET query 参数
 * @param {object} [body] POST body（JSON）
 * @returns {Promise<{status:number, data:any}>}
 */
export async function callDnshe(account, endpoint, action, query, body) {
  let url = `${DNSHE_BASE}&endpoint=${endpoint}&action=${action}`;
  if (query && typeof query === 'object') {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += `&${qs}`;
  }

  // 官方文档（V2.0）规范：
  //   - GET（list 类查询）只带 X-API-Key / X-API-Secret，不带 Content-Type
  //   - POST（create/assist/cancel/update 等写操作）才带 Content-Type: application/json
  const headers = body
    ? {
        'X-API-Key': account['X-API-Key'],
        'X-API-Secret': account['X-API-Secret'],
        'Content-Type': 'application/json',
      }
    : {
        'X-API-Key': account['X-API-Key'],
        'X-API-Secret': account['X-API-Secret'],
      };

  // 重试 2 次：525（SSL 握手失败）、5xx、网络错误
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 800 * attempt));
    try {
      const resp = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      let data = {};
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (resp.status >= 500 || resp.status === 525) {
        last = { status: resp.status, data };
        continue;
      }
      return { status: resp.status, data };
    } catch (e) {
      last = { status: 0, data: { error: e.message } };
    }
  }
  return last || { status: 0, data: { error: 'unknown' } };
}

/**
 * 查询账号的永久升级中心状态
 * @returns {Promise<object>} state 对象（含 helper_assist_remaining / requests / assist_logs ...）
 */
export async function getUpgradeState(account) {
  const { status, data } = await callDnshe(account, 'permanent_upgrade', 'list', { page: 1, per_page: 50 });
  if (status === 200 && data && data.success) {
    return data.state || {};
  }
  return { error: data && data.message ? data.message : `HTTP ${status}` };
}

/**
 * 查询账号下的所有子域名（含到期时间）
 * @returns {Promise<{subdomains: Array, error?: string}>}
 */
export async function getSubdomains(account) {
  const { status, data } = await callDnshe(account, 'subdomains', 'list');
  if (status === 200 && data && data.success) {
    const subs = data.data?.subdomains || data.subdomains || [];
    return {
      subdomains: subs.map(s => ({
        id: s.id,
        subdomain: s.subdomain,
        rootdomain: s.rootdomain,
        full_domain: s.full_domain || (s.subdomain ? `${s.subdomain}.${s.rootdomain}` : ''),
        status: s.status,
        expires_at: s.expires_at,
        never_expires: s.never_expires,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
    };
  }
  return { subdomains: [], error: data && data.message ? data.message : `HTTP ${status}` };
}
