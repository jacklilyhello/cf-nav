#!/usr/bin/env python3
"""Build initial navigation data from recorded probes and reviewed editorial rules.

This is an explicit one-time legacy migration dataset, not automatic publication
of future health-check results. Review decisions remain in legacy-audit.json.
"""
import collections
import datetime
import html
import json
import re
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return json.loads((ROOT / 'data' / name).read_text())


def write(name, value):
    (ROOT / 'data' / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    inventory = read('legacy-extracted.json')
    probes = {x['id']: x for x in read('legacy-probes.json')}
    rules = read('legacy-editorial.json')
    replacements = {x['legacy_id']: x for x in read('legacy-replacement-probes.json') if x['id'].startswith('update-')}
    encoding = {x['legacy_id']: x for x in read('legacy-replacement-probes.json') if x['id'].startswith('encoding-')}
    https = {x['legacy_id']: x for x in read('legacy-https-probes.json')}
    assert len(probes) == len(inventory['items']) == 198
    categories = [
        ('productivity', '效率与知识', '写作、协作与日常效率，让工作更从容。'),
        ('development', '开发与技术', '代码、工具与社区，连接每一个灵感。'),
        ('design', '设计与创作', '从构思到成品，找到顺手的创作工具。'),
        ('assets', '视觉素材', '字体、图标、色彩与灵感，构建独特表达。'),
        ('research', '科研与数据', '开放数据、科学计算与研究支持。'),
        ('media', '影音与阅读', '在声音、影像与文字中探索。'),
        ('cloud', '云与存储', '云计算、文件管理与安全同步。'),
    ]
    category_map = {'生物信息': 'research', '云服务器': 'cloud', '网盘资源': 'cloud', '办公学习': 'productivity',
                    '影音视频': 'media', '游戏竞技': 'media', '图标素材': 'assets', '图标设计': 'assets', '平面素材': 'assets',
                    '字体资源': 'assets', 'PPT资源': 'productivity', '图形创意': 'design', '界面设计': 'design',
                    '在线配色': 'assets', '迷你工具': 'development', '谷歌插件': 'development', '资讯书籍': 'media',
                    '博客论坛': 'development', '设计规范': 'design', '视频教程': 'design', '常用工具': 'productivity'}
    category_overrides = {3: 'development', 5: 'development', 6: 'design', 10: 'development', 16: 'development',
                          126: 'design', 128: 'design', 142: 'research'}
    descriptions = {
        1: '文档与知识库协作，整理个人和团队知识。', 2: '腾讯 QQ 邮箱的官方网页登录入口。',
        3: '开源项目、技术文章与开发者交流社区。', 4: '微信订阅号与服务号的内容和账号管理。',
        5: '代码托管、开源协作与开发者社区。', 6: '在浏览器中编辑图像、图层与设计素材。',
        8: '估算房贷月供与还款计划，具体以贷款合同为准。', 10: '在浏览器中测试和播放 M3U8 / HLS 视频流。',
        16: '开发者与创意工作者的交流社区。', 17: '美国国家生物技术信息中心的数据库与研究资源。',
        18: '用于生物信息学软件分发的 Conda 软件包频道。', 19: 'Perl 模块、文档与发行版本检索。',
        21: 'R 统计计算与绘图环境的官方网站。', 22: '开放的生物信息数据分析与 R 软件资源。',
        23: '阿里云计算、云产品与开发者服务。', 24: '腾讯云计算、基础设施与技术服务。',
        25: '华为云计算、开发平台与行业服务。', 29: '网易有道词典与语言学习工具。',
        30: '有道文本、文档与网页翻译工具。', 32: '在线绘制流程图、思维导图与协作图表。',
        33: '腾讯视频官方影视与综艺平台。', 34: '优酷官方剧集、综艺和视频平台。',
        35: '爱奇艺官方影视与视频平台。', 36: '哔哩哔哩视频、知识与创作社区。',
        37: 'QQ 音乐官方在线音乐与歌单平台。', 38: '网易云音乐官方音乐与歌单社区。',
        40: '电影天堂影视资源目录。', 42: 'A.V.A 战地之王台服官方资讯与游戏入口。',
        43: '百度网盘文件存储、备份与分享。', 44: '阿里云盘的文件存储、备份与整理服务。',
        45: '中国电信天翼云盘与家庭文件备份。', 48: '阿里巴巴矢量图标库，管理与使用图标。',
        49: '简洁图标资源，支持 SVG 等格式。', 50: '查找和下载图标与贴纸素材。',
        52: '将 SVG 图标整理并导出为字体、图标或精灵图。', 57: 'Font Awesome 图标与界面符号库。',
        58: 'Ionic 的开源界面图标集。', 61: '浏览来自 iOS App Store 的应用图标设计。',
        65: '浏览适合桌面和移动设备的壁纸。', 68: '正版图片、设计素材与模板资源。',
        69: 'PNG 透明素材、背景图片与设计图库。', 70: '图像素材、平面设计与空间装饰资源。',
        71: '电商设计模板、PNG 素材与背景图。', 72: '原创图片、素材与设计作品共享平台。',
        76: '图片、矢量和设计文件素材目录。', 77: 'Google 开源字体目录、预览与字体知识。',
        79: '方正字体产品、授权与字体资源。', 83: '浏览字体分类、预览并查找下载资源。',
        84: '独立设计师合作制作的字体与字形。', 87: '按分类查找和预览字体。',
        88: '字体检索、预览、购买与授权。', 89: '按风格浏览与预览字体，使用前确认授权。',
        90: '字体目录、预览与网页字体资源。', 91: '按分类查找和预览字体资源。',
        93: '演示文稿模板、图表与背景资源。', 104: '免费开源的三维建模、动画与渲染工具。',
        105: '界面设计、原型、协作与开发交付。', 108: '界面原型、用户测试与设计协作平台。',
        110: '协作设计、交互原型与开发交付平台。', 111: '根据偏好探索和组合适合设计的色彩。',
        112: '浏览、预览并复制 CSS 渐变配色。', 114: '为界面设计精选的渐变色组合。',
        115: '可预览和复制的 CSS 背景渐变集合。', 116: '可视化调整与复制 CSS 渐变。',
        117: '每日色彩与配色灵感。', 118: '按主题浏览并复制扁平风格配色。',
        120: '为设计与创作收集的配色方案。', 121: 'Adobe 色轮、配色方案与色彩工具。',
        126: '压缩 PNG、JPEG 和 WebP 图片。', 127: '创建二维码并调整输出格式。',
        128: 'GIF 动画制作、转换、裁剪与图像处理。', 129: '为 Android 界面生成可调整的阴影素材。',
        132: '识别网站使用的技术与服务。', 133: '聚合阅读常用网站与创意技术资讯。',
        134: '面向开发者的响应式网站调试浏览器。', 135: '在浏览器中检查网页样式和设计属性。',
        137: '通过新标签页探索世界各地的风景。', 138: '微信读书官方网页阅读入口。',
        139: '编程和互联网技术的开源书籍与文档。', 140: '订阅 RSS、管理新闻源与阅读信息。',
        141: '技术、创业与计算机领域的新闻讨论社区。', 142: '经济、管理、金融和统计学习交流社区。',
        143: '技术文章、编程知识与科技爱好者周刊。', 146: '开源设计系统、规范与组件库资源集合。',
        148: 'Apple 平台界面、交互与无障碍设计指南。', 150: 'Photoshop 图像处理与设计教程目录。',
        151: '创意设计软件与视觉制作学习课程。', 153: '编程、开发与设计领域的在线课程。',
    }
    links, decisions = [], []
    for item in inventory['items']:
        rid = item['id']
        number = int(rid[-3:])
        raw = probes[rid]
        evidence = encoding.get(rid, raw)
        probe = evidence.get('probe', {})
        status = evidence['health_status']
        action = 'retain' if status in ('healthy', 'redirected') else 'remove' if status in ('domain_for_sale', 'domain_parking', 'not_found', 'gone') else 'review'
        reason = evidence['reason']
        url = item['url']
        name = rules['renames'].get(rid, item['name'])
        description = descriptions.get(number, html.unescape(item.get('description', '')))
        sources = sorted({x['source'] for x in item['occurrences']})
        if 'card' not in sources:
            action = 'remove'
            reason = '旧搜索输入模板、装饰、第三方接口或友情链接，不导入独立资源卡；探测状态独立保留，不据此宣称服务死亡。'
            if number in (182, 187):
                status = 'duplicate'
                reason = '相同站点的协议、主机或结尾斜杠变体，不重复迁移。'
            elif number in (188, 189, 195, 196, 198):
                status = 'template_legacy'
                reason = '原模板仓库、备案、服务接口或作者站点；按要求移除模板遗留。'
            elif number == 197:
                reason = '旧 About 页的站点所有者个人主页，与资源导航卡片不同；保留来源审计，不作为模板作者或死亡站点处理。'
        override = rules['overrides'].get(rid, {})
        action = override.get('action', action)
        status = override.get('status', status)
        reason = override.get('reason', reason)
        name = override.get('name', name)
        description = override.get('description', description)
        url = override.get('url', url)
        if rid in rules['updates']:
            update = rules['updates'][rid]
            verification = replacements[rid]
            assert verification['health_status'] in ('healthy', 'redirected') or update.get('browserTitle')
            action, status = 'update', 'moved'
            name, url, description, reason = (update[x] for x in ('name', 'url', 'description', 'reason'))
            probe = verification['probe']
            evidence = verification
        elif action == 'retain' and probe.get('url', '').startswith('https://') and not urllib.parse.urlsplit(probe['url']).query and number != 23 and probe['url'] != url:
            url, action = probe['url'], 'update'
            reason += ' 使用已核实且用途一致的 HTTPS 最终地址。'
        if action in ('retain', 'update') and rid in https and https[rid]['health_status'] in ('healthy', 'redirected'):
            secure = https[rid]
            probe, evidence, url, action = secure['probe'], secure, secure['url'], 'update'
            reason += ' HTTPS 入口已实际探测通过。'
        # Outbound links in the new directory always use verified HTTPS. The old
        # insecure resource remains available in the audit for future review.
        if action in ('retain', 'update') and not url.startswith('https://'):
            action, status = 'review', 'needs_review'
            reason = '当前用途仍可辨识，但未建立可用 HTTPS 入口；保留审计，不纳入首次发布。'
        decision = {'id': rid, 'name': item['name'], 'category': item['category'], 'originalUrl': item['url'],
                    'originalPurpose': item['description'], 'sources': sources, 'observedStatus': raw['health_status'],
                    'status': status, 'action': action, 'reason': reason,
                    'currentTitle': probe.get('title'), 'currentUrl': probe.get('url'), 'httpStatus': probe.get('http_status'),
                    'checkedAt': evidence.get('checked_at'), 'publishedUrl': url if action in ('retain', 'update') else None,
                    'probeRecord': rid, 'source': override.get('source') or rules['updates'].get(rid, {}).get('source')}
        decisions.append(decision)
        if action not in ('retain', 'update'):
            continue
        category = category_overrides.get(number, category_map[item['category']])
        checked_at = evidence.get('checked_at')
        health_status = status if status in ('healthy', 'redirected', 'moved', 'needs_review', 'bot_protection', 'blocked') else 'needs_review'
        observed_title = rules['updates'].get(rid, {}).get('browserTitle') or override.get('browserTitle') or probe.get('title')
        links.append({'id': rid, 'categoryId': category, 'name': name, 'url': url, 'description': description,
                      'icon': name[:2], 'sortOrder': len(links) * 10, 'enabled': True,
                      'featured': number in (1, 5, 17, 31, 77, 104, 110, 126), 'notes': reason,
                      'expectedKeywords': [name], 'healthStatus': health_status, 'healthOverride': None, 'checkDisabled': False,
                      'lastCheckedAt': checked_at, 'lastSuccessAt': checked_at, 'lastFailureAt': None,
                      'nextCheckAt': checked_at, 'finalUrl': probe.get('url') or url, 'httpStatus': probe.get('http_status'),
                      'consecutiveFailures': 0, 'lastError': None, 'observedTitle': observed_title,
                      'healthEvidence': [reason], 'updatedAt': checked_at})
    seed = {'version': 1, 'mode': 'merge', 'categories': [
        {'id': key, 'slug': key, 'name': name, 'description': description, 'sortOrder': index * 10,
         'enabled': True, 'updatedAt': '2026-10-02T00:00:00Z'} for index, (key, name, description) in enumerate(categories)], 'links': links}
    assert len({x['url'].rstrip('/') for x in links}) == len(links)
    assert all('?ref=' not in x['url'] and 'utm_' not in x['url'] for x in links)
    assert not any(x['id'] in ('legacy-055', 'legacy-113', 'legacy-188', 'legacy-196') for x in links)
    counts = collections.Counter(x['action'] for x in decisions)
    status_counts = collections.Counter(x['status'] for x in decisions)
    card_decisions = [x for x in decisions if 'card' in x['sources']]
    summary = {
        'date': '2026-10-02', 'inventory': inventory['counts'],
        'publishedLinks': len(links), 'publishedCategories': len(categories), 'actions': dict(counts),
        'cardActions': dict(collections.Counter(x['action'] for x in card_decisions)), 'statuses': dict(status_counts),
        'updatedUrls': counts['update'], 'removedTargets': counts['remove'], 'needsReviewTargets': counts['review'],
        'deadExactUrls': status_counts['not_found'] + status_counts['gone'],
        'replacedOrChangedTargets': status_counts['content_changed'], 'parkedOrForSaleTargets': status_counts['domain_parking'] + status_counts['domain_for_sale'],
        'semanticDuplicateTargetsRemoved': status_counts['duplicate'],
        'exactRepeatedOccurrencesCollapsed': inventory['counts']['navigation_occurrences'] - len(decisions),
        'referralEntriesRemoved': 1, 'quickOpenConflictsResolved': 4,
        'method': 'Complete browser DOM inventory, legacy JavaScript inspection, bounded public-DNS-pinned HTTP probes, manual title/purpose review, official migration pages, and targeted browser verification.',
        'definitions': {
            'deadExactUrls': 'Final reviewed 404/410 legacy destinations without an accepted replacement; does not count 403, challenges, DNS, TLS, timeouts or temporary 5xx as dead.',
            'review': 'Unconfirmed destinations remain in the audit and are not published; optional future editorial review, not a required deployment action.',
            'updatedUrls': 'Accepted canonical HTTPS destinations, repaired official paths, or verified official migrations. Each changed published URL counts once.',
            'removedTargets': 'Includes obsolete search-query templates and third-party template integrations; does not imply all removed services are dead.'},
        'templateRemoval': ['Web_tool credit and repository link', 'ShumLab author attribution and website', 'Legacy contact email omitted from stored data', 'Unrelated legacy ICP registration', 'Old friend links', 'Quote/weather/remote template API integrations', 'Referral query and duplicated editor card'],
    }
    write('legacy-audit.json', {'version': 1, 'summary': summary, 'records': decisions})
    write('seed.json', seed)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
