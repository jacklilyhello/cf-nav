export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
}
export interface NavLink {
  id: string;
  categoryId: string;
  name: string;
  url: string;
  description: string;
  icon: string;
  sortOrder: number;
  enabled: boolean;
  featured: boolean;
  notes?: string;
  healthStatus: string;
  lastCheckedAt: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  consecutiveFailures: number;
  lastError?: string | null;
  checkDisabled?: boolean;
  healthOverride?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
}
export interface Catalog {
  categories: Category[];
  links: NavLink[];
  meta: { version: number; updatedAt: string | null };
}
export function escape(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
export function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}
export function formatDate(value?: string | null): string {
  if (!value) return '尚未检测';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '未知时间'
    : new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Singapore',
      }).format(date);
}
const icons: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  star: '<path d="m12 3 2.7 5.8 6.3.7-4.6 4.4 1.2 6.3L12 17l-5.6 3.2 1.2-6.3L3 9.5l6.3-.7Z"/>',
  arrow: '<path d="M6 18 18 6M6 6h12v12"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
  tool: '<path d="m14 5 5 5m-8 1-8 8 2 2 8-8m-1-7a6 6 0 0 1 8-3l-4 4 3 3 4-4a6 6 0 0 1-8 8"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18"/>',
  book: '<path d="M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  refresh: '<path d="M20 7A9 9 0 0 0 4 6M4 2v4h4M4 17a9 9 0 0 0 16 1m0 4v-4h-4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5"/>',
  upload: '<path d="M12 15V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  logout: '<path d="M9 3H3v18h6M9 12h12m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="m12 3 10 18H2ZM12 9v5m0 3v.1"/>',
  link: '<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2"/>',
};
export function icon(name: string, cls = ''): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.folder}</svg>`;
}
export function brand(): string {
  return `<a class="brand" href="/" aria-label="Lily 寻迹首页"><span class="brand-mark"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="m9 33 11-21 7 14 4-8 8 15M14 33h20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="35" cy="11" r="2" fill="#D9C19A"/></svg></span><span>Lily <span class="brand-divider">/</span> 寻迹<small>EXPLORE WITH INTENT</small></span></a>`;
}
export function categoryIcon(category: Category, index = 0): string {
  const name = category.name.toLowerCase();
  if (/设计|创意|design|灵感/.test(name)) return 'spark';
  if (/开发|代码|程序|dev/.test(name)) return 'code';
  if (/图|摄影|photo|视觉/.test(name)) return 'image';
  if (/学习|阅读|知识|文档|learn/.test(name)) return 'book';
  if (/工具|效率|tool/.test(name)) return 'tool';
  if (/生活|娱乐|影音|life/.test(name)) return 'heart';
  return ['globe', 'folder', 'spark', 'book'][index % 4]!;
}
export function healthInfo(raw: string | undefined | null): { label: string; tone: string } {
  const key = (raw || 'unknown').toLowerCase().replace(/[ -]/g, '_');
  const table: Record<string, [string, string]> = {
    healthy: ['可访问', 'good'],
    redirected: ['已重定向', 'good'],
    moved: ['已迁移', 'review'],
    unknown: ['待检测', 'neutral'],
    pending: ['待检测', 'neutral'],
    needs_review: ['待复核', 'review'],
    bot_protection: ['访问验证', 'neutral'],
    challenge: ['访问验证', 'neutral'],
    blocked: ['访问受限', 'neutral'],
    forbidden: ['访问受限', 'neutral'],
    rate_limited: ['请求受限', 'neutral'],
    domain_parking: ['域名停放', 'bad'],
    parked: ['域名停放', 'bad'],
    domain_for_sale: ['域名待售', 'bad'],
    service_replaced: ['服务变更', 'review'],
    replaced: ['服务变更', 'review'],
    content_changed: ['内容变更', 'review'],
    changed: ['内容变更', 'review'],
    not_found: ['页面不存在', 'bad'],
    gone: ['页面已移除', 'bad'],
    server_error: ['服务异常', 'bad'],
    dns_error: ['DNS 异常', 'bad'],
    tls_error: ['TLS 异常', 'bad'],
    timeout: ['检测超时', 'review'],
    connection_refused: ['连接失败', 'bad'],
    connection_error: ['连接失败', 'bad'],
    unreachable: ['暂不可达', 'bad'],
    dead: ['不可访问', 'bad'],
    ignored: ['暂停检测', 'neutral'],
    '403': ['访问受限', 'neutral'],
    '404': ['页面不存在', 'bad'],
    '410': ['页面已移除', 'bad'],
    '429': ['请求受限', 'neutral'],
    '5xx': ['服务异常', 'bad'],
  };
  const item = table[key] || [raw || '待检测', 'neutral'];
  return { label: item[0]!, tone: item[1]! };
}
export function healthBadge(link: NavLink): string {
  const info = healthInfo(
    link.checkDisabled ? 'ignored' : link.healthOverride || link.healthStatus,
  );
  const title = `${info.label}${link.healthOverride ? ' · 人工确认' : ''} · ${formatDate(link.lastCheckedAt)}${link.httpStatus ? ` · HTTP ${link.httpStatus}` : ''}`;
  return `<span class="health health-${info.tone}" title="${escape(title)}"><span></span>${escape(info.label)}</span>`;
}
export function siteIcon(link: NavLink): string {
  const hash = [...link.name].reduce((value, char) => value + char.charCodeAt(0), 0) % 6;
  const value = (link.icon || '').trim();
  const textIcon = value.length <= 16 && !value.includes('://') ? value : '';
  const custom = !textIcon && value.startsWith('https:') ? safeUrl(value) : '';
  const label = textIcon || [...link.name][0]?.toUpperCase() || '↗';
  const textClass =
    label.length > 6 ? 'icon-text-long' : label.length > 2 ? 'icon-text-medium' : '';
  return `<span class="site-icon color-${hash}">${custom ? `<img src="${escape(custom)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : `<span class="${textClass}">${escape(label)}</span>`}</span>`;
}

export function validIcon(value: string): boolean {
  if (!value || (value.length <= 16 && !value.includes('://'))) return true;
  return value.length <= 500 && value.startsWith('https:') && Boolean(safeUrl(value));
}
export function isPublicLink(link: NavLink, categories: Category[]): boolean {
  return Boolean(
    link.enabled &&
    categories.some((category) => category.id === link.categoryId && category.enabled),
  );
}
export function bindImageFallback(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>('.site-icon img').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        img.replaceWith(document.createTextNode('↗'));
      },
      { once: true },
    );
  });
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(20000),
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}
export function toast(message: string, failed = false): void {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = `toast${failed ? ' toast-error' : ''}`;
  element.setAttribute('role', failed ? 'alert' : 'status');
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 4200);
}
