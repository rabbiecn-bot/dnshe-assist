/**
 * POST /api/assist — 用好友助力码触发助力
 * 请求体：{ "assist_code": "XXXX", "max_accounts": 5 }
 * 逻辑：
 *   1. 遍历所有账号，查询各自的剩余助力次数（helper_assist_remaining）
 *   2. 按剩余次数排序（多的优先），依次调用 permanent_upgrade assist API
 *   3. 每个账号助力成功即记录到 KV；失败（已助力过/限流等）则尝试下一个账号
 *   4. 默认最多使用 max_accounts 个账号（默认 5，即凑满一次升级所需）
 * 响应：{ success, results: [{name, ok, message}], total_success }
 */
import { getAccounts, getUpgradeState, callDnshe } from '../_dnshe.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const accounts = getAccounts(env);

  if (accounts.length === 0) {
    return Response.json({ success: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const assistCode = (body.assist_code || '').toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(assistCode)) {
    return Response.json({ success: false, error: '助力码格式不正确（6-16 位字母数字）' }, { status: 400 });
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
      // 该账号是否已经助力过此码（从 assist_logs 判断）
      alreadyHelped: (s.state.assist_logs || []).some(l =>
        l.role === 'assisted' && l.assist_code && l.assist_code.toUpperCase() === assistCode),
    }))
    .sort((a, b) => b.remaining - a.remaining); // 剩余多的优先

  if (usable.length === 0) {
    return Response.json({ success: false, error: '所有账号查询状态失败' }, { status: 502 });
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

    // 2. 调用 assist API
    const { status, data } = await callDnshe(u.acct, 'permanent_upgrade', 'assist', { assist_code: assistCode });

    const ok = status === 200 && data && data.success;
    const message = ok
      ? (data.message || '助力成功')
      : (data && data.message) || (data && data.error) || `HTTP ${status}`;

    results.push({ name: u.acct.name, ok, message });
    if (ok) totalSuccess++;

    // 3. 记录到 KV
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
        // 最多保留 500 条
        await env.ASSIST_KV.put('assist:history', JSON.stringify(history.slice(-500)));
      } catch (e) {
        console.error('KV write error:', e.message);
      }
    }

    // 避免限流，每次调用间隔 300ms
    await new Promise(r => setTimeout(r, 300));
  }

  return Response.json({
    success: totalSuccess > 0,
    assist_code: assistCode,
    total_success: totalSuccess,
    max_accounts: maxAccounts,
    results,
  });
}
