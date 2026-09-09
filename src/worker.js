/**
 * DNSHE 助力助手 Worker 入口
 * 路由：
 *   GET  /api/status  — 所有账号状态（剩余助力次数、域名列表、助力码、助力记录）
 *   POST /api/create  — 为指定域名生成助力码（创建永久升级任务）
 *   POST /api/assist  — 用助力码触发助力（依次使用多个账号）
 * 其余请求由 static assets（public/）处理
 */
import { getAccounts, getUpgradeState, callDnshe } from './dnshe.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS（同源部署可留空；跨域需要时放开）
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === '/api/status' && method === 'GET') {
      return handleStatus(env, cors);
    }
    if (path === '/api/create' && method === 'POST') {
      return handleCreate(request, env, cors);
    }
    if (path === '/api/assist' && method === 'POST') {
      return handleAssist(request, env, cors);
    }

    // 其余交给 static assets
    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/** GET /api/status */
async function handleStatus(env, cors) {
  const accounts = getAccounts(env);
  if (accounts.length === 0) {
    return json({ success: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' }, 500, cors);
  }

  const results = await Promise.all(accounts.map(async (acct) => {
    const state = await getUpgradeState(acct);
    if (state.error) return { name: acct.name, error: state.error };

    return {
      name: acct.name,
      assist_required: state.assist_required ?? 5,
      helper_assist_limit: state.helper_assist_limit ?? 15,
      helper_assist_count: state.helper_assist_count ?? 0,
      helper_assist_remaining: state.helper_assist_remaining ?? 0,
      helper_limit_reached: state.helper_limit_reached ?? false,
      // 可升级域名（未永久，可生成助力码）
      eligible_domains: (state.eligible_domains || []).map(d => ({
        id: d.id,
        domain: d.domain,
        status: d.status,
      })),
      // 全部已创建任务的域名
      requests: (state.requests || []).map(r => ({
        id: r.id,
        domain: r.domain,
        assist_code: r.assist_code,
        assist_count: r.assist_count,
        target_assists: r.target_assists,
        status: r.status,
        created_at: r.created_at,
        upgraded_at: r.upgraded_at,
      })),
      assist_logs: (state.assist_logs || []).slice(0, 50).map(l => ({
        id: l.id,
        role: l.role,
        domain: l.domain,
        assist_code: l.assist_code,
        counterpart: l.counterpart,
        created_at: l.created_at,
      })),
    };
  }));

  // 读取本地助力历史（KV）
  let assist_history = [];
  if (env.ASSIST_KV) {
    try {
      const raw = await env.ASSIST_KV.get('assist:history');
      if (raw) assist_history = JSON.parse(raw);
    } catch (e) { console.error('KV read error:', e.message); }
  }

  return json({
    success: true,
    updated_at: new Date().toISOString(),
    accounts: results,
    assist_history,
  }, 200, cors);
}

/** POST /api/create — 为域名生成助力码 */
async function handleCreate(request, env, cors) {
  const accounts = getAccounts(env);
  if (accounts.length === 0) {
    return json({ success: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400, cors); }

  const accountName = (body.account || '').trim();
  const subdomainId = body.subdomain_id;

  if (!accountName || !subdomainId) {
    return json({ success: false, error: '缺少 account 或 subdomain_id 参数' }, 400, cors);
  }

  const acct = accounts.find(a => a.name === accountName);
  if (!acct) {
    return json({ success: false, error: `未找到账号 ${accountName}` }, 404, cors);
  }

  const { status, data } = await callDnshe(acct, 'permanent_upgrade', 'create', null, { subdomain_id: subdomainId });
  if (status === 200 && data && data.success) {
    return json({
      success: true,
      account: accountName,
      message: data.message || '助力码生成成功',
      data: data.data || data,
    }, 200, cors);
  }
  return json({
    success: false,
    message: (data && data.message) || (data && data.error) || `HTTP ${status}`,
  }, 502, cors);
}

/** POST /api/assist — 用助力码触发助力 */
async function handleAssist(request, env, cors) {
  const accounts = getAccounts(env);
  if (accounts.length === 0) {
    return json({ success: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' }, 500, cors);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: '请求体不是合法 JSON' }, 400, cors); }

  const assistCode = (body.assist_code || '').toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(assistCode)) {
    return json({ success: false, error: '助力码格式不正确（6-16 位字母数字）' }, 400, cors);
  }

  const maxAccounts = Math.min(Math.max(parseInt(body.max_accounts) || 5, 1), 15);

  // 1. 获取所有账号状态（并发），挑出有剩余次数的
  const states = await Promise.all(accounts.map(async (acct) => {
    const state = await getUpgradeState(acct);
    return { acct, state };
  }));

  const usable = states
    .filter(s => !s.state.error)
    .map(s => ({
      acct: s.acct,
      remaining: s.state.helper_assist_remaining ?? 0,
      alreadyHelped: (s.state.assist_logs || []).some(l =>
        l.role === 'assisted' && l.assist_code && l.assist_code.toUpperCase() === assistCode),
    }))
    .sort((a, b) => b.remaining - a.remaining);

  if (usable.length === 0) {
    return json({ success: false, error: '所有账号查询状态失败' }, 502, cors);
  }

  const results = [];
  let totalSuccess = 0;

  for (const u of usable) {
    if (totalSuccess >= maxAccounts) break;

    if (u.remaining <= 0) {
      results.push({ name: u.acct.name, ok: false, message: '助力次数已用完' });
      continue;
    }
    if (u.alreadyHelped) {
      results.push({ name: u.acct.name, ok: false, message: '已助力过该助力码' });
      continue;
    }

    const { status, data } = await callDnshe(u.acct, 'permanent_upgrade', 'assist', null, { assist_code: assistCode });

    const ok = status === 200 && data && data.success;
    const message = ok
      ? (data.message || '助力成功')
      : (data && data.message) || (data && data.error) || `HTTP ${status}`;

    results.push({ name: u.acct.name, ok, message });
    if (ok) totalSuccess++;

    if (ok && env.ASSIST_KV) {
      try {
        const raw = await env.ASSIST_KV.get('assist:history');
        const history = raw ? JSON.parse(raw) : [];
        history.push({
          ts: new Date().toISOString(),
          account: u.acct.name,
          assist_code: assistCode,
          message,
        });
        await env.ASSIST_KV.put('assist:history', JSON.stringify(history.slice(-500)));
      } catch (e) { console.error('KV write error:', e.message); }
    }

    await new Promise(r => setTimeout(r, 300));
  }

  return json({
    success: totalSuccess > 0,
    assist_code: assistCode,
    total_success: totalSuccess,
    max_accounts: maxAccounts,
    results,
  }, 200, cors);
}
