#!/usr/bin/env python3
"""Normalize the read-only browser DOM snapshot into an auditable input inventory.

legacy-cards.tsv preserves card order and descriptions. An empty quickUrl means
the quick-open URL equals the card URL, including the two malformed card URLs.
The browser extraction covered h4/a.card, all a[href], input[type=radio],
data-url, and URL literals in inline scripts. Assets are inventoried separately.
"""
import csv
import datetime
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    cards = list(csv.DictReader((ROOT / 'data/legacy-cards.tsv').open(), delimiter='\t'))
    assert len(cards) == 149, 'The captured DOM contains exactly 149 cards'
    for card in cards:
        card['quickUrl'] = card['quickUrl'] or card['url']
        card['dataUrl'] = card['url']
    search = [
        ('baidu', '百度一下，你就知道', 'https://www.baidu.com/s?wd='),
        ('bing', '微软 Bing 搜索', 'https://cn.bing.com/search?q='),
        ('google', '谷歌搜索', 'https://www.google.com/search?q='),
        ('anaconda', 'Anaconda 软件搜索', 'https://anaconda.org/search?q='),
        ('pubmed', 'PubMed 搜索/文章标题/关键字', 'https://pubmed.ncbi.nlm.nih.gov/?term='),
        ('baidu1', '百度一下，你就知道', 'https://www.baidu.com/s?wd='),
        ('google1', '谷歌搜索', 'https://www.google.com/search?q='),
        ('360', '360 好搜', 'https://www.so.com/s?q='),
        ('sogo', '搜狗搜索', 'https://www.sogou.com/web?query='),
        ('bing1', '微软 Bing 搜索', 'https://cn.bing.com/search?q='),
        ('sm', 'UC 移动端搜索', 'https://yz.m.sm.cn/s?q='),
        ('br', '请输入网址(不带 https://)', 'https://rank.chinaz.com/all/'),
        ('links', '请输入网址(不带 https://)', 'https://link.chinaz.com/'),
        ('whois', '请输入网址(不带 https://)', 'https://who.is/whois/'),
        ('ping', '请输入网址(不带 https://)', 'https://ping.chinaz.com/'),
        ('404', '请输入网址(不带https://)', 'https://tool.chinaz.com/Links/?DAddress='),
        ('ciku', '请输入关键词', 'https://www.ciku5.com/s?wd='),
        ('zhihu', '知乎', 'https://www.zhihu.com/search?type=content&q='),
        ('wechat', '微信', 'https://weixin.sogou.com/weixin?type=2&query='),
        ('weibo', '微博', 'https://s.weibo.com/weibo/'),
        ('douban', '豆瓣', 'https://www.douban.com/search?q='),
        ('taobao1', '淘宝', 'https://s.taobao.com/search?q='),
        ('jd', '京东', 'https://search.jd.com/Search?keyword='),
        ('xiachufang', '下厨房', 'https://www.xiachufang.com/search/?keyword='),
        ('xiangha', '香哈菜谱', 'https://www.xiangha.com/so/?q=caipu&s='),
        ('12306', '12306', 'https://www.12306.cn/?'),
        ('qunar', '去哪儿', 'https://www.qunar.com/?'),
        ('zhaopin', '智联招聘', 'https://sou.zhaopin.com/jobs/searchresult.ashx?kw='),
        ('51job', '前程无忧', 'https://search.51job.com/?'),
        ('lagou', '拉钩网', 'https://www.lagou.com/jobs/list_'),
        ('liepin', '猎聘网', 'https://www.liepin.com/zhaopin/?key='),
    ]
    search_records = []
    for prefix in ('type-', 'm_type-'):
        for code, name, url in search:
            if prefix == 'm_type-' and code in ('bing', 'bing1'):
                name = '微软必应搜索'
            if prefix == 'm_type-' and code == '51job':
                name, url = '远程职位', 'https://yuancheng.works'
            search_records.append({'id': prefix + code, 'name': name, 'url': url})
    extras = [
        {'name': '一言动态引语', 'url': 'https://hitokoto.cn/?uuid=7afccafc-a0a6-4c45-a7c4-dbd7f3dbeb58', 'source': 'header'},
        {'name': 'CSDN', 'url': 'https://csdn.net', 'source': 'friendlink'},
        {'name': '程序设计网', 'url': 'https://gitapp.cn/', 'source': 'friendlink'},
        {'name': '掘金社区', 'url': 'https://juejin.im', 'source': 'friendlink'},
        {'name': '阿里云社区', 'url': 'https://aliyun.com', 'source': 'friendlink'},
        {'name': 'Web_tool', 'url': 'https://github.com/geeeeeeeek/web_tool', 'source': 'footer'},
        {'name': '旧模板备案', 'url': 'http://beian.miit.gov.cn/', 'source': 'footer'},
        {'name': '一言 API', 'url': 'https://v1.hitokoto.cn', 'source': 'inline_script'},
        {'name': '一言动态跳转模板', 'url': 'https://hitokoto.cn/?uuid=', 'source': 'inline_script'},
        {'name': '百度搜索建议 API', 'url': 'https://suggestion.baidu.com/su?wd=', 'source': 'external_script'},
        {'name': 'Google 搜索建议 API', 'url': 'https://suggestqueries.google.com/complete/search?client=firefox&callback=iowenHot', 'source': 'external_script'},
        {'name': '百度旧搜索建议 API', 'url': 'https://sp0.baidu.com/5a1Fazu8AA54nxGko9WTAnF6hhy/su?cb=iowenHot', 'source': 'external_script'},
        {'name': '旧模板网站信息 API', 'url': 'https://apiv2.iotheme.cn/webinfo/get.php', 'source': 'external_script'},
        {'name': 'ShumLab 模板作者', 'url': 'https://www.shumlab.com/', 'source': 'external_script'},
        {'name': 'Lily 个人主页', 'url': 'https://lily.lat', 'source': 'about_page'},
        {'name': 'About 页占位备案链接', 'url': 'http://lily.lat/', 'source': 'about_page'},
        {'name': 'About 页 Web_tool 页脚', 'url': 'https://github.com/', 'source': 'about_page'},
    ]
    occurrences = []
    for index, card in enumerate(cards, 1):
        occurrences.append({**card, 'source': 'card', 'source_id': f'card-{index:03d}'})
        occurrences.append({**card, 'url': card['quickUrl'], 'source': 'quick_open', 'source_id': f'quick-{index:03d}'})
    occurrences += [{**entry, 'category': '旧搜索控件', 'description': entry['name'], 'source': 'search', 'source_id': entry['id']} for entry in search_records]
    occurrences += [{**entry, 'category': '旧模板及附加链接', 'description': entry['name'], 'source_id': f'extra-{index:02d}'} for index, entry in enumerate(extras, 1)]
    items = []
    by_url = {}
    for occurrence in occurrences:
        url = occurrence['url']
        if url not in by_url:
            row = {key: occurrence[key] for key in ('name', 'category', 'description', 'url')}
            row.update({'id': f'legacy-{len(items)+1:03d}', 'occurrences': []})
            by_url[url] = row
            items.append(row)
        by_url[url]['occurrences'].append({key: occurrence[key] for key in ('source', 'source_id', 'name')})
    inventory = {
        'source_url': 'https://nav.lily.lat/',
        'captured_date': '2026-10-02',
        'capture_method': 'Codex in-app browser read-only DOM extraction before production cutover; shell HTTP was WAF blocked.',
        'scope': 'Every navigation card, card data-url, quick-open button, desktop/mobile hidden search control, external header/friend/footer link, and inline-script navigation/API URL.',
        'linked_page_inspection': {'requested_url': 'https://nav.lily.lat/about', 'final_url': 'https://nav.lily.lat/about/', 'title': 'Lily在线工具网', 'anchor_elements': 6, 'external_anchor_occurrences': 3, 'javascript_controls': 3, 'script_elements': 21, 'owner_contact_text': 'Not copied: plain text contact information is not a navigation link.', 'removed_tracking_asset': 'https://sdk.51.la/js-sdk-pro.min.js'},
        'excluded_non_navigation': {'same_page_or_relative_or_javascript_anchors': 40, 'script_elements': 21,
                                    'inline_asset_url': 'https://nav.baidu.cn/wp-content/themes/onenav/images/add.png',
                                    'reason': 'Local UI controls, asset URLs and third-party telemetry/weather scripts are not navigation destinations and are not migrated.'},
        'counts': {'anchor_elements': 345, 'cards': len(cards), 'quick_open_buttons': len(cards),
                   'hidden_search_controls': len(search_records), 'external_header_friend_footer_links': 7,
                   'linked_about_page_external_links': 3,
                   'inline_navigation_api_urls': 2, 'external_script_navigation_api_urls': 5, 'navigation_occurrences': len(occurrences),
                   'distinct_raw_targets_including_two_invalid_cards': len(items),
                   'distinct_http_targets': sum(x['url'].startswith(('http://', 'https://')) for x in items),
                   'quick_open_mismatches': sum(x['url'] != x['quickUrl'] for x in cards)},
        'browser_transfer_verification': {'card_text_length': 14864, 'card_text_rolling_checksum': 903912347, 'algorithm': 'uint32(hash * 31 + Unicode code point), lines category/name/url/description/quickUrl joined by tabs and newline'},
        'external_script_inspection': {'content-search.js': {'http_status': 200, 'characters': 3621}, 'app-anim.js': {'http_status': 200, 'characters': 56842}, 'excluded_documentation_link': 'https://www.jsdelivr.com/using-sri-with-dynamic-files'},
        'cards': cards, 'search_controls': search_records, 'extra_links': extras, 'items': items,
    }
    (ROOT / 'data/legacy-extracted.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(inventory['counts'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
