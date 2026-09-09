/**
 * GET /api/status — 返回所有 DNSHE 账号的永久升级状态 + 助力记录
 * 响应：
 * {
 *   success: true,
 *   accounts: [{
 *     name, assist_required, helper_assist_limit, helper_assist_count,
 *     helper_assist_remaining, helper_limit_reached, eligible_domains,
 *     requests: [{id, domain, assist_code, assist_count, target_assists, status, created_at, upgraded_at}],
 *     assist_logs: [{id, role, domain, assist_code, counterpart, created_at}],
 *     error?
 *   }],
 *   assist_history: [...KV 本地记录]
 * }
 */
import { getAccounts, getUpgradeState } from '../_dnshe.js';

export async function onRequestGet(context) {
  const { env } = context;
  const accounts = getAccounts(env);

  if (accounts.length === 0) {
    return Response.json({ success: false, error: 'DNSHE_ACCOUNTS 环境变量未配置' }, { status: 500 });
  }

  // 并发查询所有账号状态
  const results = await Promise.all(accounts.map(async (acct) => {
    const state = await getUpgradeState(acct);
    if (state.error) {
      return { name: acct.name, error: state.error };
    }
    return {
      name: acct.name,
      assist_required: state.assist_required ?? 5,
      helper_assist_limit: state.helper_assist_limit ?? 15,
      helper_assist_count: state.helper_assist_count ?? 0,
      helper_assist_remaining: state.helper_assist_remaining ?? 0,
      helper_limit_reached: state.helper_limit_reached ?? false,
      eligible_domains: (state.eligible_domains || []).map(d => d.domain),
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
    } catch (e) {
      console.error('KV read error:', e.message);
    }
  }

  return Response.json({
    success: true,
    updated_at: new Date().toISOString(),
    accounts: results,
    assist_history,
  });
}
