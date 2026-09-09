/**
 * Pages Functions 适配层（catch-all）
 *
 * dnshe-assist 原本是 Workers 项目；为避开 Workers 出口 IP 被 DNSHE 临时封禁，
 * 改用 Cloudflare Pages Functions 部署（同 dnsmanage），Pages 出口 IP 池与 Workers 不同、
 * 经验证可正常访问 DNSHE API。
 *
 * 这里把所有 /api/* 请求转发给原 Worker fetch handler，业务逻辑零修改：
 *   GET  /api/status  — 读 KV 缓存
 *   POST /api/sync    — 全量同步 DNSHE → KV
 *   POST /api/create  — 生成助力码
 *   POST /api/assist  — 触发助力
 */
import worker from '../../src/worker.js';

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);

  // 非 /api/* 路径交给 Pages 静态资源（public/）处理
  if (!url.pathname.startsWith('/api/')) {
    return next();
  }

  return worker.fetch(request, env);
}