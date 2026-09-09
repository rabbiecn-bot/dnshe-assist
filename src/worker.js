/**
 * DNSHE 助力助手 Worker 入口
 *
 * 缓存架构（同 dnsmanage A 方案）：
 *   - KV 是读取缓存，前端 /api/status 纯 KV 读取（0 次 DNSHE 请求）
 *   - /api/sync 一键同步：从 DNSHE 权威拉取全量数据覆盖 KV 缓存
 *   - create / assist 写操作直连 DNSHE（有需要才发请求），成功后刷新缓存
 *
 * 路由：
 *   GET  /api/status  — 读 KV 缓存（无缓存自动 sync）
 *   POST /api/sync    — 从 DNSHE 权威拉取全量数据写 KV（含账号额度、域名、到期）
 *   POST /api/create  — 为指定域名生成助力码（直连 DNSHE）
 *   POST /api/assist  — 用助力码触发助力（直连 DNSHE）
 */
import { getAccounts, getUpgradeState, getSubdomains, getQuota, callDnshe } from './dnshe.js';

const CACHE_KEY = 'status:cache';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

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
    if (path === '/api/sync' && method === 'POST') {
      return handleSync(env, cors);
    }
    if (path === '/api/create' && method === 'POST') {
      return handleCreate(request, env, cors);
    }
    if (path === '/api/assist' && method === 'POST') {
      return handleAssist(request, env, cors);
    }

    // Pages 部署下静态资源由 Pages 直接服务（适配层已把非 /api/* 交给 next()），
    // 这里只兜底未知 /api/* 路由
    return new Response(JSON.stringify({ success: false, error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
};

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/* ==================== KV 缓存读写 ==================== */

async function readCache(env) {
  if (!env.ASSIST_KV) return null;
  try {
    const raw = await env.ASSIST_KV.get(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('KV cache read error:', e.message);
    return null;
  }
}

async function writeCache(env, snapshot) {
  if (!env.ASSIST_KV) return;
  try {
    await env.ASSIST_KV.put(CACHE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    console.error('KV cache write error:', e.message);
  }
}

/* ==================== 权威数据拉取（sync） ==================== */

/**
 * 从 DNSHE 拉取所有账号全量状态：额度 + 域名列表（含到期）+ 助力任务 + 助力记录 + 域名注册额度
 * 每个账号 3 次请求（permanent_upgrade list + subdomains list + quota），6 账号 ≈ 18 次
 * 注意：串行 + 间隔执行（DNSHE 30 次/分钟限流，且 525 防护对并发敏感）
 */
async function fetchAllAccounts(env) {
  const accounts = getAccounts(env);
  if (accounts.length === 0) {
    return { ok: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' };
  }

  const results = [];
  for (const acct of accounts) {
    const state = await getUpgradeState(acct);
    if (state.error) {
      console.error(`[sync] ${acct.name} getUpgradeState failed: ${state.error}`);
      results.push({ name: acct.name, error: state.error });
      continue;
    }

    // 域名列表（subdomains，含到期时间）
    const { subdomains, error: subError } = await getSubdomains(acct);
    if (subError) {
      console.error(`[sync] ${acct.name} getSubdomains failed: ${subError}`);
      results.push({ name: acct.name, error: `额度 OK，但域名列表失败: ${subError}` });
      continue;
    }

    // 域名注册额度（quota）
    const { quota, error: quotaError } = await getQuota(acct);
    if (quotaError) {
      console.error(`[sync] ${acct.name} getQuota failed: ${quotaError}`);
      // quota 失败不中断，仅缺失该字段
    }

    // 合并：requests 里的域名标记升级状态/助力码；未在 requests 且未永久的标记可升级
    const reqMap = {};
    (state.requests || []).forEach(r => { reqMap[r.domain || r.subdomain] = r; });

    const domains = subdomains.map(s => {
      const req = reqMap[s.full_domain];
      const isUpgraded = s.never_expires === 1 || s.status === '永久' || s.status === 'Permanent';
      const inProgress = !isUpgraded && req && (req.assist_code || req.status);
      return {
        id: s.id,
        domain: s.full_domain,
        status: isUpgraded ? 'upgraded' : (inProgress ? 'in_progress' : 'eligible'),
        never_expires: s.never_expires,
        expires_at: s.expires_at,
        created_at: s.created_at,
        // 有升级任务时补充
        assist_code: req ? (req.assist_code || '') : '',
        assist_count: req ? (req.assist_count || 0) : 0,
        target_assists: req ? (req.target_assists || 5) : 5,
        request_status: req ? (req.status || '') : '',
      };
    });

    results.push({
      name: acct.name,
      assist_required: state.assist_required ?? 5,
      helper_assist_limit: state.helper_assist_limit ?? 15,
      helper_assist_count: state.helper_assist_count ?? 0,
      helper_assist_remaining: state.helper_assist_remaining ?? 0,
      helper_limit_reached: state.helper_limit_reached ?? false,
      quota, // {used, base, invite_bonus, total, available} 或 null
      domains,
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
    });

    // 串行间隔，降低瞬时请求密度
    await new Promise(r => setTimeout(r, 350));
  }

  // 读助力历史（KV 持久）
  let assist_history = [];
  if (env.ASSIST_KV) {
    try {
      const raw = await env.ASSIST_KV.get('assist:history');
      if (raw) assist_history = JSON.parse(raw);
    } catch (e) { console.error('KV read error:', e.message); }
  }

  // 归一化助力历史（以 DNSHE assist_logs 为权威源，KV 补充时间戳）：
  // ① 同一助力码只保留一条（需求：不管助力几次都只记录一条）
  // ② 账号/域名直接用 DNSHE 返回的加密字段（counterpart/domain，非完整）
  // ③ 助力次数 = 该码 assisted 记录条数（历史累计，可能不是 5，因为之前可能已有人助力过）
  const assistedMap = new Map(); // assist_code -> {domain, account, count, ts}
  for (const r of results) {
    if (r.error) continue;
    for (const l of (r.assist_logs || [])) {
      if (l.role !== 'assisted' || !l.assist_code) continue;
      const k = l.assist_code.toUpperCase();
      if (!assistedMap.has(k)) assistedMap.set(k, { domain: '', account: '', count: 0, ts: '' });
      const e = assistedMap.get(k);
      if (l.domain) e.domain = l.domain;
      if (l.counterpart) e.account = l.counterpart;
      e.count++;
      if (l.created_at && (!e.ts || l.created_at > e.ts)) e.ts = l.created_at;
    }
  }
  // KV 记录补充时间戳/兼容（若 assist_logs 缺失该码但 KV 有，仍保留）
  for (const h of (Array.isArray(assist_history) ? assist_history : [])) {
    const k = (h.assist_code || '').toString().toUpperCase();
    if (!k) continue;
    if (!assistedMap.has(k)) {
      assistedMap.set(k, { domain: h.domain || '', account: h.account || '', count: h.count || 1, ts: h.ts || '' });
    } else if (!assistedMap.get(k).ts && h.ts) {
      assistedMap.get(k).ts = h.ts;
    }
  }
  assist_history = Array.from(assistedMap.entries())
    .map(([code, e]) => ({
      ts: e.ts || new Date().toISOString(),
      assist_code: code,
      domain: e.domain,
      account: e.account,
      count: e.count,
    }))
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  return {
    ok: true,
    updated_at: new Date().toISOString(),
    accounts: results,
    assist_history,
  };
}

/* ==================== 路由处理 ==================== */

/** GET /api/status — 纯 KV 读取，0 次 DNSHE 请求 */
async function handleStatus(env, cors) {
  let snapshot = await readCache(env);
  if (!snapshot) {
    // 首次无缓存 → 自动同步一次
    snapshot = await fetchAllAccounts(env);
    if (snapshot.ok) await writeCache(env, snapshot);
  }
  if (!snapshot || !snapshot.ok) {
    return json({ success: false, error: (snapshot && snapshot.error) || '缓存为空且同步失败' }, 500, cors);
  }
  return json({ success: true, cached: true, ...snapshot }, 200, cors);
}

/** POST /api/sync — 从 DNSHE 权威拉取全量覆盖缓存（部分失败时保留旧数据） */
async function handleSync(env, cors) {
  const snapshot = await fetchAllAccounts(env);
  if (!snapshot.ok) {
    return json({ success: false, error: snapshot.error }, 502, cors);
  }

  // 有账号失败的 sync：合并旧缓存数据，避免 KV 被错误覆盖
  const failed = snapshot.accounts.filter(a => a.error);
  if (failed.length > 0) {
    const old = await readCache(env);
    if (old && old.accounts) {
      snapshot.accounts = snapshot.accounts.map(a =>
        a.error ? (old.accounts.find(o => o.name === a.name) || a) : a);
      snapshot.partial = true;
    }
  }

  await writeCache(env, snapshot);
  return json({ success: true, cached: false, ...snapshot }, 200, cors);
}

/** POST /api/create — 为域名生成助力码（直连 DNSHE，成功后刷新缓存） */
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
    // 创建成功 → 后台刷新缓存（不阻塞响应）
    refreshCache(env);
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

/** POST /api/assist — 用助力码触发助力（直连 DNSHE，成功后刷新缓存） */
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

  // 1. 获取所有账号状态（串行 + 间隔，官方文档：批量操作不支持、必须逐个调用）
  const states = [];
  for (const acct of accounts) {
    const state = await getUpgradeState(acct);
    states.push({ acct, state });
    await new Promise(r => setTimeout(r, 300));
  }

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

    await new Promise(r => setTimeout(r, 300));
  }

  // 助力记录：同一助力码只记一条（不管域名是否已升级永久，只要助力了就记录）
  // 记录内容：加密账号(counterpart)、加密域名(domain)、助力码、成功助力次数
  if (totalSuccess > 0 && env.ASSIST_KV) {
    try {
      // 拉一次状态取该码最新的 assisted 日志（domain/counterpart 本身是 DNSHE 加密后的）
      let domainMasked = '', accountMasked = '';
      const okAccount = usable.find(u => results.some(r => r.name === u.acct.name && r.ok));
      if (okAccount) {
        const st = await getUpgradeState(okAccount.acct);
        if (!st.error) {
          const log = (st.assist_logs || [])
            .filter(l => l.role === 'assisted' && l.assist_code === assistCode)
            .pop();
          if (log) {
            domainMasked = log.domain || '';
            accountMasked = log.counterpart || '';
          }
        }
      }
      const raw = await env.ASSIST_KV.get('assist:history');
      let history = raw ? JSON.parse(raw) : [];
      // 同码去重：旧的按账号逐条记录（account/message 格式）也一并清理
      history = history.filter(h => h.assist_code !== assistCode);
      history.push({
        ts: new Date().toISOString(),
        assist_code: assistCode,
        domain: domainMasked,
        account: accountMasked,
        count: totalSuccess,
      });
      await env.ASSIST_KV.put('assist:history', JSON.stringify(history.slice(-200)));
    } catch (e) { console.error('KV write error:', e.message); }
  }

  // 助力结束 → 刷新缓存
  refreshCache(env);

  return json({
    success: totalSuccess > 0,
    assist_code: assistCode,
    total_success: totalSuccess,
    max_accounts: maxAccounts,
    results,
  }, 200, cors);
}

/** 后台刷新 KV 缓存（不阻塞响应） */
async function refreshCache(env) {
  try {
    const snapshot = await fetchAllAccounts(env);
    if (snapshot.ok) await writeCache(env, snapshot);
  } catch (e) {
    console.error('cache refresh error:', e.message);
  }
}
