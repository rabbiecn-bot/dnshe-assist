/**
 * DNSHE API 客户端（Pages Function 共享模块）
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
 * @param {object} account 账号对象
 * @param {string} endpoint 端点（subdomains / dns_records / quota / permanent_upgrade ...）
 * @param {string} action 动作（list / create / assist / cancel ...）
 * @param {object} [body] POST body（JSON）
 * @returns {Promise<{status:number, data:any}>}
 */
export async function callDnshe(account, endpoint, action, body) {
  const url = `${DNSHE_BASE}&endpoint=${endpoint}&action=${action}`;
  const headers = {
    'X-API-Key': account['X-API-Key'],
    'X-API-Secret': account['X-API-Secret'],
    'Content-Type': 'application/json',
  };
  try {
    const resp = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: resp.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
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
