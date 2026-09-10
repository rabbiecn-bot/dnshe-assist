#!/usr/bin/env python3
"""
幂等确保 ASSIST_KV namespace 存在并回填 wrangler.toml

由 .github/workflows/deploy.yml 调用，解决「换 CF 账号部署时 KV namespace
不存在」的问题。执行顺序（保证幂等、绝不误建）：

  1. 读取 wrangler.toml 中 binding=ASSIST_KV 的当前 id
  2. 若当前 id 不是占位符，且在当前账号中存在 → 直接复用，不做任何改动
  3. 否则按 title（dnshe-assist-assist-kv）查找已有 namespace → 找到则回填
  4. 都没有 → 创建新 namespace 并回填 wrangler.toml

需要环境变量：
  CLOUDFLARE_API_TOKEN   CF API Token（Workers/KV/Pages 权限）
  CLOUDFLARE_ACCOUNT_ID  CF Account ID
"""
import json
import os
import re
import sys
import urllib.request

API = 'https://api.cloudflare.com/client/v4'
TITLE = 'dnshe-assist-assist-kv'
PLACEHOLDERS = {'YOUR_ASSIST_KV_ID', 'YOUR_...', '', 'CHANGE_ME'}


def cf_req(method, path, body=None):
    token = os.environ.get('CLOUDFLARE_API_TOKEN') or os.environ.get('CF_API_TOKEN')
    if not token:
        sys.exit('[ensure-kv] FAILED: 缺少 CLOUDFLARE_API_TOKEN / CF_API_TOKEN')
    headers = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
    }
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')
    except Exception as e:
        sys.exit(f'[ensure-kv] FAILED: 请求异常 {e}')


def extract_current_id(toml_text):
    """提取 wrangler.toml 中 binding=ASSIST_KV 块的 id"""
    m = re.search(
        r'\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"ASSIST_KV"[\s\S]*?id\s*=\s*"([^"]*)"',
        toml_text,
    )
    return m.group(1).strip() if m else ''


def backfill(toml_path, kv_id):
    with open(toml_path, 'r', encoding='utf-8') as f:
        text = f.read()
    new_text, changed = re.subn(
        r'(binding\s*=\s*"ASSIST_KV"[\s\S]*?id\s*=\s*")[^"]*(")',
        lambda m: m.group(1) + kv_id + m.group(2),
        text,
        count=1,
    )
    if not changed:
        if 'ASSIST_KV' not in text:
            block = f'\n[[kv_namespaces]]\nbinding = "ASSIST_KV"\nid = "{kv_id}"\n'
            new_text = text.rstrip() + block
            changed = True
        else:
            sys.exit('[ensure-kv] FAILED: 无法在 wrangler.toml 中定位 ASSIST_KV binding 的 id')
    with open(toml_path, 'w', encoding='utf-8') as f:
        f.write(new_text)
    print(f'[ensure-kv] wrangler.toml 已回填 ASSIST_KV id = {kv_id}')


def main():
    acc_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID') or os.environ.get('CF_ACCOUNT_ID')
    if not acc_id:
        sys.exit('[ensure-kv] FAILED: 缺少 CLOUDFLARE_ACCOUNT_ID / CF_ACCOUNT_ID')

    toml_path = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'wrangler.toml'))
    with open(toml_path, 'r', encoding='utf-8') as f:
        toml_text = f.read()

    # 1. wrangler.toml 已有 id 且非占位符 → 验证在当前账号是否存在
    current_id = extract_current_id(toml_text)
    if current_id and current_id not in PLACEHOLDERS:
        status, d = cf_req('GET', f'/accounts/{acc_id}/storage/kv/namespaces/{current_id}')
        if status == 200 and d.get('success'):
            print(f'[ensure-kv] ASSIST_KV 已存在且有效，复用: {current_id}')
            return  # 不做任何改动
        print(f'[ensure-kv] wrangler.toml 中的 id {current_id} 在当前账号不存在（status={status}），需要重新分配')

    # 2. 按 title 查找已有 namespace（幂等）
    existing = None
    page = 1
    while True:
        status, d = cf_req('GET', f'/accounts/{acc_id}/storage/kv/namespaces?per_page=100&page={page}')
        if status != 200 or not d.get('success'):
            sys.exit(f'[ensure-kv] FAILED: 查询 KV namespace 失败 status={status} {json.dumps(d)[:300]}')
        for ns in d.get('result', []):
            if ns.get('title') == TITLE:
                existing = ns
                break
        if existing or len(d.get('result', [])) < 100:
            break
        page += 1

    # 3. 找到 → 回填；找不到 → 创建
    if existing:
        kv_id = existing['id']
        print(f'[ensure-kv] 按 title 找到已有 ASSIST_KV: {kv_id}')
    else:
        status, d = cf_req('POST', f'/accounts/{acc_id}/storage/kv/namespaces', {'title': TITLE})
        if status != 200 or not d.get('success'):
            sys.exit(f'[ensure-kv] FAILED: 创建 KV namespace 失败 status={status} {json.dumps(d)[:300]}')
        kv_id = d['result']['id']
        print(f'[ensure-kv] ASSIST_KV 创建成功: {kv_id}')

    backfill(toml_path, kv_id)

    # 4. 校验
    with open(toml_path, 'r', encoding='utf-8') as f:
        final = f.read()
    if kv_id not in final:
        sys.exit('[ensure-kv] FAILED: 回填校验未通过')
    print('[ensure-kv] OK')


if __name__ == '__main__':
    main()
