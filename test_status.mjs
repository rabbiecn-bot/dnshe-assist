// 本地模拟 Worker 环境，验证 src/dnshe.js + status 逻辑
import { getAccounts, getUpgradeState } from './src/dnshe.js';

const env = { DNSHE_ACCOUNTS: process.env.DNSHE_ACCOUNTS };

const accounts = getAccounts(env);
console.log('账号数:', accounts.length);
for (const a of accounts) {
  const state = await getUpgradeState(a);
  if (state.error) {
    console.log(`❌ ${a.name}: ${state.error}`);
    continue;
  }
  console.log(`✅ ${a.name}: 剩余助力=${state.helper_assist_remaining}/${state.helper_assist_limit}, 已达上限=${state.helper_limit_reached}, requests=${(state.requests||[]).length}, eligible=${(state.eligible_domains||[]).length}`);
}
