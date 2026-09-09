// 本机脚本：从 DNSHE 拉全量数据，组装成与 fetchAllAccounts 相同的结构，写入 CF KV
// 用于 CF Worker 出口 IP 被 DNSHE 临时封禁(525)时的应急缓存恢复
import { getAccounts, getUpgradeState, getSubdomains } from './src/dnshe.js';
import { writeFileSync } from 'fs';

const env = { DNSHE_ACCOUNTS: process.env.DNSHE_ACCOUNTS };
const accounts = getAccounts(env);

const results = [];
for (const acct of accounts) {
  const state = await getUpgradeState(acct);
  if (state.error) {
    results.push({ name: acct.name, error: state.error });
    console.log(`❌ ${acct.name}: ${state.error}`);
    continue;
  }
  const { subdomains, error: subError } = await getSubdomains(acct);
  if (subError) {
    results.push({ name: acct.name, error: `域名列表失败: ${subError}` });
    console.log(`❌ ${acct.name}: ${subError}`);
    continue;
  }

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
    domains,
    requests: (state.requests || []).map(r => ({
      id: r.id, domain: r.domain, assist_code: r.assist_code,
      assist_count: r.assist_count, target_assists: r.target_assists,
      status: r.status, created_at: r.created_at, upgraded_at: r.upgraded_at,
    })),
    assist_logs: (state.assist_logs || []).slice(0, 50).map(l => ({
      id: l.id, role: l.role, domain: l.domain, assist_code: l.assist_code,
      counterpart: l.counterpart, created_at: l.created_at,
    })),
  });
  console.log(`✅ ${acct.name}: 剩余=${state.helper_assist_remaining} 域名=${domains.length}`);
  await new Promise(r => setTimeout(r, 350));
}

const snapshot = {
  ok: true,
  updated_at: new Date().toISOString(),
  accounts: results,
  assist_history: [],  // KV 里已有历史，这里置空避免覆盖（由 Python 端保留）
};

writeFileSync('/tmp/dnshe_snapshot.json', JSON.stringify(snapshot));
console.log('快照已写入 /tmp/dnshe_snapshot.json');
