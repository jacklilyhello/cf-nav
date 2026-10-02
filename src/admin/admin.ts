import {
  api,
  bindImageFallback,
  brand,
  contentBadge,
  contentInfo,
  escape,
  formatDate,
  healthBadge,
  healthInfo,
  hostname,
  httpLabel,
  icon,
  safeUrl,
  siteIcon,
  toast,
  validIcon,
  isPublicLink,
  type Catalog,
  type Category,
  type NavLink,
} from '../frontend/ui';
import { createBackupParts, MAX_IMPORT_BYTES, type BackupPart } from '../frontend/backup';
import { ApiError } from '../frontend/api';
import { themeControl, bindThemeControls } from '../frontend/theme';

type ManagedLink = NavLink & {
  expectedKeywords?: string[];
  healthNextRequestAt?: number | null;
  healthPendingSettings?: SiteSettings | null;
};
type AdminCatalog = Omit<Catalog, 'links'> & { links: ManagedLink[] };
interface SiteSettings {
  allowIndexing: boolean;
  healthUserAgent: string;
  healthIntervalSeconds: number;
  healthTimeoutSeconds: number;
  environment?: 'staging' | 'production';
  effectiveAllowIndexing?: boolean;
}
interface HealthHistory {
  checkedAt: string;
  status: string;
  httpStatus: number | null;
  contentStatus?: string;
  similarityScore?: number | null;
  error?: string | null;
  finalUrl?: string | null;
  probeUserAgent?: string | null;
  probeIntervalSeconds?: number | null;
  probeTimeoutSeconds?: number | null;
}
interface Session {
  authenticated: boolean;
  email: string;
  csrfToken: string;
}
const overrides = [
  'healthy',
  'needs_review',
  'moved',
  'content_changed',
  'domain_parking',
  'domain_for_sale',
  'not_found',
  'gone',
  'unknown',
];

export async function mountAdmin(app: HTMLDivElement): Promise<void> {
  document.title = '管理控制台 · Lily 寻迹';
  app.innerHTML = `<main class="standalone" id="main">${brand()}<div class="standalone-theme">${themeControl()}</div><div class="empty-state"><span class="loading-indicator"></span><h2>正在验证管理员身份</h2><p>安全连接建立后，即可管理你的数字花园。</p></div></main>`;
  bindThemeControls(app);
  let session: Session;
  let data: AdminCatalog;
  let activeTab = 'links';
  let search = '';
  let categoryFilter = '';
  let statusFilter = '';
  let settings: SiteSettings | undefined;
  let iconDiscoveryRunning = false;
  let stopIconDiscovery = false;
  try {
    session = await api<Session>('/api/admin/session');
    if (!session.authenticated || typeof session.csrfToken !== 'string')
      throw new ApiError('authentication', '请重新验证管理员身份。');
    data = await api<AdminCatalog>('/api/admin/data');
  } catch (error) {
    const authentication = error instanceof ApiError && error.code === 'authentication';
    const challenge = error instanceof ApiError && error.code === 'challenge';
    const title = authentication
      ? '请验证管理员身份'
      : challenge
        ? '请先完成浏览器安全验证'
        : '暂时无法连接管理服务';
    const message =
      error instanceof ApiError ? error.message : '网络连接暂时不可用，请重试或重新登录。';
    app.innerHTML = `<main class="standalone" id="main">${brand()}<div class="standalone-theme">${themeControl()}</div><section class="login-panel"><span class="login-symbol">${icon('shield')}</span><span class="eyebrow">A PRIVATE SPACE TO CURATE</span><h1>${title}</h1><p>${escape(message)}</p><a class="button primary" href="/admin/login">${icon('shield')}通过 Cloudflare Access 登录${icon('arrow')}</a><button class="button secondary" id="reload-admin">重新连接</button><span class="login-note">仅限站点管理员 · 安全身份验证</span><a class="back-home" href="/">返回公开导航</a></section></main>`;
    bindThemeControls(app);
    document.querySelector('#reload-admin')?.addEventListener('click', () => {
      void mountAdmin(app);
    });
    return;
  }
  sortData();
  app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar">${brand()}<span class="admin-space-label">PRIVATE WORKSPACE</span><nav aria-label="管理菜单"><button class="admin-nav active" data-tab="links">${icon('link')}导航资源</button><button class="admin-nav" data-tab="categories">${icon('folder')}分类管理</button><button class="admin-nav" data-tab="health">${icon('shield')}健康检测</button><button class="admin-nav" data-tab="settings">${icon('tool')}站点设置</button></nav><div class="admin-sidebar-bottom"><a class="admin-nav" href="/">${icon('arrow')}打开前台</a><div class="session-info">${icon('shield')}<span>已安全登录<small>${escape(session.email)}</small></span></div><button class="admin-nav" id="logout">${icon('logout')}退出登录</button></div></aside><div class="admin-workspace"><header class="admin-topbar"><span>管理控制台 <span class="slash">/</span> <span id="admin-breadcrumb">导航资源</span></span><div class="admin-topbar-actions">${themeControl()}<a href="/">查看站点 ${icon('arrow')}</a></div></header><main id="main" class="admin-main"><div class="admin-heading"><div><span class="eyebrow">CURATE YOUR DIGITAL GARDEN</span><h1 id="admin-title">导航资源</h1><p id="admin-description">让每一个收藏，都有值得留下的理由。</p></div><div class="admin-actions"><button class="button secondary" id="export-data">${icon('download')}导出</button><button class="button secondary" id="import-data">${icon('upload')}导入</button><button class="button secondary" id="discover-icons">${icon('image')}补齐自动图标</button><button class="button primary" id="add-item">${icon('plus')}新增资源</button></div></div><div class="admin-stats" id="admin-stats"></div><div class="icon-discovery-progress" id="icon-discovery-progress" hidden><p id="icon-discovery-status" role="status"></p><button type="button" class="button secondary" id="stop-icon-discovery">停止获取</button></div><div class="admin-panel"><div class="admin-filters"><div class="admin-search">${icon('search')}<label class="visually-hidden" for="admin-search">搜索资源或分类</label><input id="admin-search" type="search" placeholder="搜索名称、网址或分类…" autocomplete="off" /></div><label class="visually-hidden" for="category-filter">筛选分类</label><select id="category-filter"><option value="">全部分类</option></select><label class="visually-hidden" for="status-filter">筛选状态</label><select id="status-filter"><option value="">全部状态</option><option value="enabled">前台显示</option><option value="hidden">已隐藏</option><option value="featured">精选推荐</option><option value="review">需要关注</option></select><button class="icon-button" id="refresh-data" aria-label="刷新管理数据">${icon('refresh')}</button></div><div id="admin-list" aria-live="polite"></div><div class="admin-list-footer" id="admin-list-footer"></div></div><p class="admin-footnote">内容修改保存后即生效。健康检测结果供维护参考；访问受限不等于网站失效。</p></main></div></div>`;
  bindThemeControls(app);
  const searchInput = document.querySelector<HTMLInputElement>('#admin-search')!;
  const categorySelect = document.querySelector<HTMLSelectElement>('#category-filter')!;
  const statusSelect = document.querySelector<HTMLSelectElement>('#status-filter')!;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      activeTab = button.dataset.tab!;
      if (activeTab === 'settings') settings = undefined;
      search = '';
      searchInput.value = '';
      categoryFilter = '';
      categorySelect.value = '';
      statusFilter = '';
      statusSelect.value = '';
      document.querySelectorAll<HTMLElement>('[data-tab]').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.tab === activeTab);
      });
      render();
    }),
  );
  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim().toLocaleLowerCase();
    renderList();
  });
  categorySelect.addEventListener('change', () => {
    categoryFilter = categorySelect.value;
    renderList();
  });
  statusSelect.addEventListener('change', () => {
    statusFilter = statusSelect.value;
    renderList();
  });
  document
    .querySelector('#add-item')!
    .addEventListener('click', () => (activeTab === 'categories' ? editCategory() : editLink()));
  document.querySelector('#refresh-data')!.addEventListener('click', () => {
    void action(async () => {
      await reload();
      toast('数据已更新');
    });
  });
  document.querySelector('#export-data')!.addEventListener('click', () => {
    void action(exportData);
  });
  document.querySelector('#import-data')!.addEventListener('click', importData);
  document.querySelector('#discover-icons')!.addEventListener('click', () => {
    void action(discoverPendingIcons);
  });
  document.querySelector('#stop-icon-discovery')!.addEventListener('click', () => {
    stopIconDiscovery = true;
    document.querySelector<HTMLButtonElement>('#stop-icon-discovery')!.disabled = true;
    document.querySelector('#icon-discovery-status')!.textContent += ' · 当前请求完成后停止';
  });
  document.querySelector('#logout')!.addEventListener('click', () => {
    void action(async () => {
      const result = await write<{ ok: boolean; logoutUrl?: string }>('/api/admin/logout', 'POST');
      location.assign(result.logoutUrl === '/cdn-cgi/access/logout' ? result.logoutUrl : '/admin');
    });
  });
  render();

  function sortData(): void {
    data.categories.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    data.links.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }
  async function write<T = { ok: boolean; id?: string }>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    return api<T>(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function action(callback: () => Promise<void>): Promise<void> {
    try {
      await callback();
    } catch (error) {
      if (error instanceof ApiError && ['authentication', 'challenge'].includes(error.code)) {
        toast(error.message, true);
        if (!document.querySelector('#admin-reauthenticate')) {
          const link = document.createElement('a');
          link.id = 'admin-reauthenticate';
          link.className = 'button primary';
          link.href = '/admin/login';
          link.textContent = '重新验证管理员身份';
          document.querySelector('.admin-actions')?.prepend(link);
        }
        return;
      }
      toast((error as Error).message, true);
    }
  }
  async function reload(): Promise<void> {
    data = await api<AdminCatalog>('/api/admin/data');
    sortData();
    // A background icon run must not discard unsaved site settings.
    if (activeTab !== 'settings') render();
  }
  function render(): void {
    const title =
      activeTab === 'settings'
        ? '站点设置'
        : activeTab === 'categories'
          ? '分类管理'
          : activeTab === 'health'
            ? '健康检测'
            : '导航资源';
    document.querySelector('#admin-title')!.textContent = title;
    document.querySelector('#admin-breadcrumb')!.textContent = title;
    document.querySelector('#admin-description')!.textContent =
      activeTab === 'settings'
        ? '管理搜索引擎收录与健康探测，让维护保持从容。'
        : activeTab === 'categories'
          ? '为你的收藏整理秩序，让发现变得轻松。'
          : activeTab === 'health'
            ? '关注变化与异常，让收藏始终值得信赖。'
            : '让每一个收藏，都有值得留下的理由。';
    document.querySelector('#add-item')!.innerHTML =
      `${icon('plus')}${activeTab === 'categories' ? '新增分类' : '新增资源'}`;
    const isSettings = activeTab === 'settings';
    document.querySelector<HTMLElement>('.admin-actions')!.hidden = isSettings;
    document.querySelector<HTMLButtonElement>('#discover-icons')!.hidden = activeTab !== 'links';
    document.querySelector<HTMLButtonElement>('#discover-icons')!.disabled = iconDiscoveryRunning;
    document.querySelector<HTMLElement>('.admin-filters')!.hidden = isSettings;
    document.querySelector<HTMLElement>('#admin-stats')!.hidden = isSettings;
    document.querySelector<HTMLElement>('#admin-list-footer')!.hidden = isSettings;
    document
      .querySelector<HTMLElement>('.admin-panel')!
      .classList.toggle('settings-panel', isSettings);
    categorySelect.hidden = activeTab === 'categories';
    statusSelect.hidden = activeTab === 'categories';
    categorySelect.innerHTML =
      '<option value="">全部分类</option>' +
      data.categories
        .map(
          (category) =>
            `<option value="${escape(category.id)}" ${category.id === categoryFilter ? 'selected' : ''}>${escape(category.name)}</option>`,
        )
        .join('');
    const reviewCount = data.links.filter(needsAttention).length;
    document.querySelector('#admin-stats')!.innerHTML =
      `<div><span>收藏资源</span><strong>${data.links.length}<small>个</small></strong></div><div><span>前台显示</span><strong>${data.links.filter(publiclyVisible).length}<small>个</small></strong></div><div><span>内容分类</span><strong>${data.categories.length}<small>组</small></strong></div><div><span>需要关注</span><strong class="attention-number">${reviewCount}<small>项</small></strong></div>`;
    renderList();
  }
  async function discoverPendingIcons(): Promise<void> {
    if (iconDiscoveryRunning) return;
    const pending = data.links.filter((link) => link.iconMode === 'auto' && !link.iconCheckedAt);
    if (!pending.length) {
      toast('所有自动图标都已尝试获取；可在编辑资源中单独重新获取');
      return;
    }
    iconDiscoveryRunning = true;
    stopIconDiscovery = false;
    const button = document.querySelector<HTMLButtonElement>('#discover-icons')!;
    const stop = document.querySelector<HTMLButtonElement>('#stop-icon-discovery')!;
    const status = document.querySelector<HTMLElement>('#icon-discovery-status')!;
    document.querySelector<HTMLElement>('#icon-discovery-progress')!.hidden = false;
    button.disabled = true;
    stop.disabled = false;
    stop.hidden = false;
    let completed = 0;
    let failed = 0;
    try {
      for (const link of pending) {
        if (stopIconDiscovery) break;
        status.textContent = `正在获取 ${completed + 1} / ${pending.length}：${link.name}。人工图标会保留。`;
        try {
          await write(`/api/admin/links/${encodeURIComponent(link.id)}/icon`, 'POST');
        } catch (error) {
          if (error instanceof ApiError && ['authentication', 'challenge'].includes(error.code)) {
            stopIconDiscovery = true;
            throw error;
          }
          failed += 1;
        }
        completed += 1;
        if (!stopIconDiscovery && completed < pending.length)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      iconDiscoveryRunning = false;
      button.disabled = false;
      stop.hidden = true;
      status.textContent = `${stopIconDiscovery ? '已停止' : '图标补齐完成'} · 已处理 ${completed} / ${pending.length}${failed ? ` · ${failed} 项请求失败` : ''}。未发现可用图标的资源继续显示名称首字。`;
      await reload();
    }
  }
  async function renderSettings(): Promise<void> {
    const list = document.querySelector<HTMLDivElement>('#admin-list')!;
    if (!settings) {
      list.innerHTML =
        '<div class="empty-state"><span class="loading-indicator"></span><p>正在读取站点设置…</p></div>';
      try {
        settings = await api<SiteSettings>('/api/admin/settings');
      } catch (error) {
        if (activeTab !== 'settings') return;
        list.innerHTML = `<div class="empty-state">${icon('warning')}<h2>暂时无法读取设置</h2><p>${escape((error as Error).message)}</p><button class="button secondary" id="retry-settings">重新读取</button></div>`;
        list.querySelector('#retry-settings')?.addEventListener('click', () => {
          void renderSettings();
        });
        return;
      }
    }
    if (activeTab !== 'settings') return;
    const effective = settings.effectiveAllowIndexing ?? settings.allowIndexing;
    const restrictedOrigin =
      settings.environment === 'staging' || (settings.allowIndexing && !effective);
    list.innerHTML = `<form id="settings-form" class="settings-form"><section class="settings-section"><div class="settings-section-heading"><span class="settings-symbol">${icon('globe')}</span><div><h2>搜索引擎收录</h2><p>控制公开导航是否允许被搜索引擎发现和索引。</p></div></div><div class="indexing-status"><span class="health health-${effective ? 'good' : 'neutral'}"><span></span>当前访问地址：${effective ? '允许收录' : '禁止收录'}</span>${restrictedOrigin ? '<small>测试环境与非正式域名始终禁止收录。</small>' : ''}</div><label class="field"><span>收录设置</span><select name="allowIndexing"><option value="true" ${settings.allowIndexing ? 'selected' : ''}>允许搜索引擎收录</option><option value="false" ${!settings.allowIndexing ? 'selected' : ''}>禁止搜索引擎收录</option></select><small>保存后同步应用到 robots.txt、页面 robots 标记、响应头与 sitemap。搜索引擎何时更新结果取决于重新抓取时间。</small></label><div class="settings-links"><a href="/robots.txt" target="_blank" rel="noopener noreferrer">查看 robots.txt ${icon('arrow')}</a><a href="/sitemap.xml" target="_blank" rel="noopener noreferrer">查看 sitemap ${icon('arrow')}</a></div></section><section class="settings-section"><div class="settings-section-heading"><span class="settings-symbol">${icon('shield')}</span><div><h2>健康检测参数</h2><p>手动检测与 Cron 自动检测使用同一组设置。</p></div></div><label class="field"><span>User-Agent</span><input name="healthUserAgent" value="${escape(settings.healthUserAgent)}" required minlength="3" maxlength="256" autocomplete="off" spellcheck="false" /><small>使用 3–256 个可打印 ASCII 字符表明探测身份，例如名称、版本与网站地址。</small></label><div class="form-grid"><label class="field"><span>请求间隔（秒）</span><input name="healthIntervalSeconds" type="number" required min="1" max="3600" step="1" value="${settings.healthIntervalSeconds}" /><small>1–3600 秒（最长 1 小时）。控制站点请求与跳转请求的最小间隔。长间隔会排队续查。</small></label><label class="field"><span>单站 Timeout（秒）</span><input name="healthTimeoutSeconds" type="number" required min="2" max="60" step="1" value="${settings.healthTimeoutSeconds}" /><small>2–60 秒。DNS、连接、跳转与正文共用此检测时限；长间隔排队等待不占用时限。</small></label></div><p class="field-note">自动检测每分钟恢复到期任务。排队中的检测沿用启动时的参数，新检测使用最新设置。访问验证、403 或 429 会保留为需要人工判断的结果，不会自动删除收藏。</p></section><p class="form-error" role="alert" hidden></p><footer class="settings-footer"><span id="settings-save-state" role="status">设置保存在当前环境</span><button type="submit" class="button primary">${icon('check')}保存站点设置</button></footer></form>`;
    list.querySelector<HTMLFormElement>('#settings-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      const error = form.querySelector<HTMLElement>('.form-error')!;
      const body = {
        allowIndexing: text(form, 'allowIndexing') === 'true',
        healthUserAgent: text(form, 'healthUserAgent'),
        healthIntervalSeconds: Number(text(form, 'healthIntervalSeconds')),
        healthTimeoutSeconds: Number(text(form, 'healthTimeoutSeconds')),
      };
      error.hidden = true;
      if (body.healthUserAgent.length < 3 || !/^[\x20-\x7e]+$/.test(body.healthUserAgent)) {
        error.textContent = 'User-Agent 需要 3–256 个可打印 ASCII 字符。';
        error.hidden = false;
        return;
      }
      if (
        !Number.isInteger(body.healthIntervalSeconds) ||
        body.healthIntervalSeconds < 1 ||
        body.healthIntervalSeconds > 3600 ||
        !Number.isInteger(body.healthTimeoutSeconds) ||
        body.healthTimeoutSeconds < 2 ||
        body.healthTimeoutSeconds > 60
      ) {
        error.textContent = '请求间隔需要 1–3600 秒的整数，Timeout 需要 2–60 秒的整数。';
        error.hidden = false;
        return;
      }
      submit.disabled = true;
      submit.textContent = '正在保存…';
      void write<SiteSettings>('/api/admin/settings', 'PUT', body)
        .then(async () => {
          settings = await api<SiteSettings>('/api/admin/settings');
          if (activeTab === 'settings') {
            await renderSettings();
            document.querySelector('#settings-save-state')!.textContent = '已保存并重新读取确认';
          }
          toast('站点设置已保存');
        })
        .catch((cause: Error) => {
          error.textContent = cause.message;
          error.hidden = false;
          error.scrollIntoView({ block: 'nearest' });
        })
        .finally(() => {
          submit.disabled = false;
          submit.innerHTML = `${icon('check')}保存站点设置`;
        });
    });
  }
  function publiclyVisible(link: ManagedLink): boolean {
    return isPublicLink(link, data.categories);
  }
  function needsAttention(link: ManagedLink): boolean {
    const state = healthInfo(link.healthOverride || link.healthStatus).tone;
    return (
      !link.checkDisabled &&
      (['review', 'bad'].includes(state) ||
        ['changed', 'mismatch'].includes(link.contentStatus || ''))
    );
  }
  function renderList(): void {
    const list = document.querySelector<HTMLDivElement>('#admin-list')!;
    if (activeTab === 'settings') {
      void renderSettings();
      return;
    }
    if (activeTab === 'categories') {
      const categories = data.categories.filter((category) =>
        [category.name, category.description, category.slug]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search),
      );
      list.innerHTML = categories.length
        ? `<div class="admin-row row-label category-row"><span>分类 / 描述</span><span>资源数量</span><span>显示状态</span><span>操作</span></div>${categories.map((category) => `<div class="admin-row category-row"><div class="admin-item-name"><span class="site-icon color-0">${icon('folder')}</span><div><strong>${escape(category.name)}</strong><small>${escape(category.description || category.slug)}</small></div></div><span class="row-meta">${data.links.filter((link) => link.categoryId === category.id).length} 个资源</span><span class="visibility ${category.enabled ? '' : 'is-hidden'}">${category.enabled ? '显示' : '已隐藏'}</span><div class="row-actions"><button class="icon-button" data-up-category="${escape(category.id)}" aria-label="上移 ${escape(category.name)}" ${data.categories.indexOf(category) === 0 ? 'disabled' : ''}>↑</button><button class="icon-button" data-down-category="${escape(category.id)}" aria-label="下移 ${escape(category.name)}" ${data.categories.indexOf(category) === data.categories.length - 1 ? 'disabled' : ''}>↓</button><button class="icon-button" data-edit-category="${escape(category.id)}" aria-label="编辑 ${escape(category.name)}">${icon('edit')}</button><button class="icon-button danger-icon" data-delete-category="${escape(category.id)}" aria-label="删除 ${escape(category.name)}">${icon('trash')}</button></div></div>`).join('')}`
        : empty('还没有匹配的分类', '从新增分类开始，让资源井然有序。');
      list
        .querySelectorAll<HTMLButtonElement>('[data-edit-category]')
        .forEach((button) =>
          button.addEventListener('click', () =>
            editCategory(
              data.categories.find((category) => category.id === button.dataset.editCategory),
            ),
          ),
        );
      list
        .querySelectorAll<HTMLButtonElement>('[data-delete-category]')
        .forEach((button) =>
          button.addEventListener('click', () =>
            deleteCategory(
              data.categories.find((category) => category.id === button.dataset.deleteCategory)!,
            ),
          ),
        );
      for (const direction of ['up', 'down'] as const)
        list.querySelectorAll<HTMLButtonElement>(`[data-${direction}-category]`).forEach((button) =>
          button.addEventListener('click', () => {
            void action(async () => {
              button.disabled = true;
              const item = data.categories.find(
                (category) => category.id === button.dataset[`${direction}Category`],
              )!;
              const index = data.categories.indexOf(item);
              const other = data.categories[index + (direction === 'up' ? -1 : 1)];
              if (!other) return;
              const ordered = [...data.categories];
              [ordered[index], ordered[index + (direction === 'up' ? -1 : 1)]] = [other, item];
              for (const [position, category] of ordered.entries()) {
                if (category.sortOrder !== position * 10)
                  await write(`/api/admin/categories/${encodeURIComponent(category.id)}`, 'PUT', {
                    ...category,
                    sortOrder: position * 10,
                  });
              }
              await reload();
              toast('分类顺序已更新');
            });
          }),
        );
      document.querySelector('#admin-list-footer')!.textContent =
        `${categories.length} 个分类 · 上下箭头调整顺序，也可在编辑中设置排序值`;
      return;
    }
    const links = data.links.filter((link) => {
      const category = data.categories.find((item) => item.id === link.categoryId);
      return (
        (!search ||
          [link.name, link.url, link.description, category?.name]
            .join(' ')
            .toLocaleLowerCase()
            .includes(search)) &&
        (!categoryFilter || link.categoryId === categoryFilter) &&
        (!statusFilter ||
          (statusFilter === 'enabled' && publiclyVisible(link)) ||
          (statusFilter === 'hidden' && !publiclyVisible(link)) ||
          (statusFilter === 'featured' && link.featured) ||
          (statusFilter === 'review' && needsAttention(link)))
      );
    });
    list.innerHTML = links.length
      ? activeTab === 'health'
        ? `<div class="health-cards">${links.map(healthCard).join('')}</div>`
        : `<div class="admin-row row-label"><span>资源 / 网址</span><span>所属分类</span><span>${activeTab === 'health' ? '检测状态 / 时间' : '状态'}</span><span>操作</span></div>${links.map((link) => `<div class="admin-row"><div class="admin-item-name">${siteIcon(link)}<div><strong>${escape(link.name)}${link.featured ? `<span class="inline-star" title="精选推荐">${icon('star')}</span>` : ''}${!publiclyVisible(link) ? `<span class="hidden-tag">${link.enabled ? '分类隐藏' : '隐藏'}</span>` : ''}</strong><a href="${escape(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${escape(hostname(link.url))} ${icon('arrow')}</a></div></div><span class="row-meta row-category">${escape(data.categories.find((category) => category.id === link.categoryId)?.name || '未分类')}</span><button class="health-details" data-health="${escape(link.id)}" aria-label="查看 ${escape(link.name)} 的健康详情">${healthBadge(link)}${activeTab === 'health' ? `<small>${escape(formatDate(link.lastCheckedAt))}</small>` : ''}</button><div class="row-actions">${activeTab === 'health' ? `<button class="icon-button" data-check="${escape(link.id)}" aria-label="重新检测 ${escape(link.name)}">${icon('refresh')}</button>` : ''}<button class="icon-button" data-edit-link="${escape(link.id)}" aria-label="编辑 ${escape(link.name)}">${icon('edit')}</button><button class="icon-button danger-icon" data-delete-link="${escape(link.id)}" aria-label="删除 ${escape(link.name)}">${icon('trash')}</button></div></div>`).join('')}`
      : empty(
          '没有找到匹配的资源',
          search || categoryFilter || statusFilter
            ? '试试其他关键词或筛选条件。'
            : '新增你的第一个资源，或导入已有的 JSON 备份。',
        );
    bindImageFallback(list);
    list
      .querySelectorAll<HTMLButtonElement>('[data-edit-link]')
      .forEach((button) =>
        button.addEventListener('click', () =>
          editLink(data.links.find((link) => link.id === button.dataset.editLink)),
        ),
      );
    list
      .querySelectorAll<HTMLButtonElement>('[data-delete-link]')
      .forEach((button) =>
        button.addEventListener('click', () =>
          deleteLink(data.links.find((link) => link.id === button.dataset.deleteLink)!),
        ),
      );
    list
      .querySelectorAll<HTMLButtonElement>('[data-health]')
      .forEach((button) =>
        button.addEventListener('click', () =>
          healthDetails(data.links.find((link) => link.id === button.dataset.health)!),
        ),
      );
    list.querySelectorAll<HTMLButtonElement>('[data-check]').forEach((button) =>
      button.addEventListener('click', () => {
        void action(async () => {
          button.disabled = true;
          try {
            const response = await write<{ queued?: boolean; nextRequestAt?: string | null }>(
              `/api/admin/links/${encodeURIComponent(button.dataset.check!)}/check`,
              'POST',
            );
            await reload();
            toast(
              response.queued
                ? `检测已排队${response.nextRequestAt ? `，最早 ${formatDate(response.nextRequestAt)} 续查` : '，自动恢复后请刷新查看'}`
                : '健康检测已完成',
            );
          } finally {
            button.disabled = false;
          }
        });
      }),
    );
    document.querySelector('#admin-list-footer')!.textContent =
      `${links.length} 个资源 · ${activeTab === 'health' ? '点击详情查看跳转记录、内容基准与检测历史' : '点击健康状态查看检测详情'}`;
  }
  function healthCard(link: ManagedLink): string {
    const category = data.categories.find((item) => item.id === link.categoryId)?.name || '未分类';
    const redirects = (link.redirectChain || []).filter(
      (hop) => hop.status >= 300 && hop.status < 400,
    );
    const chain = redirects.length
      ? `<span class="redirect-summary">${redirects.map((hop) => `HTTP ${hop.status}`).join(' → ')} → ${escape(httpLabel(link))}</span>`
      : '';
    return `<article class="health-card"><header class="health-card-header"><div class="admin-item-name">${siteIcon(link)}<div><strong>${escape(link.name)}${!publiclyVisible(link) ? '<span class="hidden-tag">隐藏</span>' : ''}</strong><small>${escape(category)}${link.checkDisabled ? ' · 自动检测已暂停' : ''}</small></div></div><div class="row-actions"><button class="icon-button" data-check="${escape(link.id)}" aria-label="重新检测 ${escape(link.name)}">${icon('refresh')}</button><button class="icon-button" data-edit-link="${escape(link.id)}" aria-label="编辑 ${escape(link.name)}">${icon('edit')}</button><button class="button secondary health-open-details" data-health="${escape(link.id)}">详情 ${icon('chevron')}</button></div></header><div class="health-card-facts"><div><span class="health-fact-label">当前状态</span>${healthBadge(link)}</div><div><span class="health-fact-label">HTTP Status</span><strong class="http-status">${escape(httpLabel(link))}</strong>${chain}</div><div><span class="health-fact-label">内容相似度</span>${contentBadge(link)}</div><div><span class="health-fact-label">最后检测</span><time>${escape(formatDate(link.lastCheckedAt))}</time></div></div><div class="health-card-urls"><div><span>网址</span><a href="${escape(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${escape(link.url)} ${icon('arrow')}</a></div>${link.finalUrl && link.finalUrl !== link.url ? `<div><span>最终 URL</span><a href="${escape(safeUrl(link.finalUrl))}" target="_blank" rel="noopener noreferrer">${escape(link.finalUrl)} ${icon('arrow')}</a></div>` : ''}</div>${link.healthPendingSettings ? `<p class="field-note" role="status">检测已排队 · ${link.healthNextRequestAt ? `最早 ${escape(formatDate(new Date(link.healthNextRequestAt).toISOString()))} 续查` : '等待自动恢复'} · 使用启动时的参数 ${escape(link.healthPendingSettings.healthIntervalSeconds)} 秒间隔 / ${escape(link.healthPendingSettings.healthTimeoutSeconds)} 秒 Timeout</p>` : ''}${link.lastError ? `<p class="health-card-error">${icon('warning')}<span>${escape(link.lastError)}</span></p>` : ''}</article>`;
  }
  function empty(title: string, description: string): string {
    return `<div class="empty-state">${icon('folder')}<h2>${title}</h2><p>${description}</p></div>`;
  }
  function dialog(
    title: string,
    content: string,
    submitText: string,
    onSubmit: (form: HTMLFormElement) => Promise<void>,
    danger = false,
  ): HTMLDialogElement {
    document.querySelector('dialog')?.remove();
    const element = document.createElement('dialog');
    element.className = 'editor-dialog';
    element.setAttribute('aria-labelledby', 'dialog-title');
    element.innerHTML = `<form><header class="dialog-header"><div><span class="eyebrow">LILY / PRIVATE WORKSPACE</span><h2 id="dialog-title">${escape(title)}</h2></div><button type="button" class="icon-button close-dialog" aria-label="关闭对话框">${icon('close')}</button></header><div class="dialog-content">${content}</div><p class="form-error" role="alert" hidden></p><footer class="dialog-footer"><button type="button" class="button secondary close-dialog">取消</button><button type="submit" class="button ${danger ? 'danger' : 'primary'}">${escape(submitText)}</button></footer></form>`;
    document.body.append(element);
    const previous = document.activeElement as HTMLElement | null;
    element.addEventListener('close', () => {
      element.remove();
      previous?.focus();
    });
    element
      .querySelectorAll('.close-dialog')
      .forEach((button) => button.addEventListener('click', () => element.close()));
    element.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
      const error = form.querySelector<HTMLParagraphElement>('.form-error')!;
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = '正在处理…';
      void onSubmit(form)
        .then(() => element.close())
        .catch((cause: Error) => {
          error.textContent = cause.message;
          if (cause instanceof ApiError && ['authentication', 'challenge'].includes(cause.code)) {
            const login = document.createElement('a');
            login.className = 'button secondary';
            login.href = '/admin/login';
            login.textContent = '重新验证管理员身份';
            error.append(document.createTextNode(' 重新登录前请保留尚未保存的内容。'), login);
          }
          error.hidden = false;
          error.scrollIntoView({ block: 'nearest' });
        })
        .finally(() => {
          submit.disabled = false;
          submit.textContent = submitText;
        });
    });
    element.showModal();
    return element;
  }
  function field(
    label: string,
    name: string,
    value = '',
    type = 'text',
    required = false,
    hint = '',
  ): string {
    const maxLength =
      name === 'expectedTitle'
        ? 240
        : name === 'icon'
          ? 2048
          : name === 'name'
            ? label === '分类名称'
              ? 80
              : 120
            : name === 'url'
              ? 2048
              : 2000;
    return `<label class="field"><span>${label}${required ? '<b>*</b>' : ''}</span><input name="${name}" type="${type}" value="${escape(value)}" ${required ? 'required' : ''} ${type === 'number' ? 'min="-10000" max="10000" step="1"' : `maxlength="${maxLength}"`} />${hint ? `<small>${hint}</small>` : ''}</label>`;
  }
  function checkbox(label: string, name: string, checked: boolean): string {
    return `<label class="checkbox-field"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} /><span>${label}</span></label>`;
  }
  function text(form: HTMLFormElement, name: string): string {
    return String(new FormData(form).get(name) || '').trim();
  }
  function checked(form: HTMLFormElement, name: string): boolean {
    return new FormData(form).has(name);
  }
  function editCategory(category?: Category): void {
    dialog(
      category ? '编辑分类' : '新增分类',
      `<div class="form-grid">${field('分类名称', 'name', category?.name, 'text', true)}${field('英文标识', 'slug', category?.slug, 'text', false, '使用小写字母、数字与短横线；留空自动生成。')}</div><label class="field"><span>分类简介</span><textarea name="description" rows="3" maxlength="500">${escape(category?.description)}</textarea></label><div class="form-grid">${field('排序值', 'sortOrder', String(category?.sortOrder ?? data.categories.length * 10), 'number', true)}<div class="check-group">${checkbox('在前台显示此分类', 'enabled', category?.enabled ?? true)}</div></div>`,
      '保存分类',
      async (form) => {
        const slug =
          text(form, 'slug') ||
          text(form, 'name')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') ||
          `collection-${crypto.randomUUID().slice(0, 8)}`;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
          throw new Error('英文标识只能包含小写字母、数字和短横线。');
        await write(
          category
            ? `/api/admin/categories/${encodeURIComponent(category.id)}`
            : '/api/admin/categories',
          category ? 'PUT' : 'POST',
          {
            name: text(form, 'name'),
            slug,
            description: text(form, 'description'),
            sortOrder: Number(text(form, 'sortOrder')),
            enabled: checked(form, 'enabled'),
          },
        );
        await reload();
        toast('分类已保存');
      },
    );
  }
  function editLink(link?: ManagedLink): void {
    if (!data.categories.length) {
      toast('请先新增一个分类，再添加资源。');
      activeTab = 'categories';
      render();
      editCategory();
      return;
    }
    const savedIconMode = link?.iconMode || (link?.icon ? 'manual' : 'auto');
    const element = dialog(
      link ? '编辑导航资源' : '新增导航资源',
      `<div class="form-grid">${field('网站名称', 'name', link?.name, 'text', true)}<label class="field"><span>所属分类<b>*</b></span><select name="categoryId" required>${data.categories.map((category) => `<option value="${escape(category.id)}" ${category.id === link?.categoryId ? 'selected' : ''}>${escape(category.name)}${!category.enabled ? '（隐藏）' : ''}</option>`).join('')}</select></label></div>${field('网站地址', 'url', link?.url || 'https://', 'url', true)}<label class="field"><span>简介</span><textarea name="description" rows="2" maxlength="1000">${escape(link?.description)}</textarea></label><section class="icon-editor"><div class="icon-editor-heading"><div id="icon-preview"></div><div><h3>网站图标</h3><p>自动发现，也保留你的选择。</p></div>${link ? '<button type="button" class="button secondary" id="refresh-icon">重新获取</button>' : ''}</div><label class="field"><span>图标来源</span><select name="iconMode"><option value="auto" ${savedIconMode === 'auto' ? 'selected' : ''}>自动获取网站图标</option><option value="manual" ${savedIconMode === 'manual' ? 'selected' : ''}>人工设置图标</option><option value="none" ${savedIconMode === 'none' ? 'selected' : ''}>默认名称首字</option></select><small>自动模式会在新增资源或修改网址时发现图标。人工设置始终优先，不会被健康检测覆盖。</small></label>${field('人工图标文字或地址', 'icon', link?.icon || '', 'text', false, '支持 16 字符内的短文字或公网 HTTPS 图标地址。图片加载失败时仍显示名称首字。')}<p class="field-note" id="icon-mode-note"></p></section>${field('排序值', 'sortOrder', String(link?.sortOrder ?? data.links.length * 10), 'number', true)}<div class="checkbox-row">${checkbox('前台显示', 'enabled', link?.enabled ?? true)}${checkbox('精选推荐', 'featured', link?.featured ?? false)}</div><details class="advanced-fields" open><summary>预期内容与健康检测</summary><p class="field-note">设置你希望这个网站长期提供的内容，帮助识别域名出售、广告页或业务改变。检测结果不会自动改写这些基准。</p>${field('预期网站名称 / Title', 'expectedTitle', link?.expectedTitle || '', 'text', false, '填写稳定的站点名称或页面 Title，最多 240 字符。')}${link?.observedTitle ? `<div class="observed-content"><span>最近检测到的 Title</span><p>${escape(link.observedTitle)}</p><button type="button" class="button secondary" id="use-observed-title">经人工确认，填入预期 Title</button><small>点击只填入表单，保存资源后才更新基准。</small></div>` : ''}<label class="field"><span>预期用途 / 内容说明</span><textarea name="expectedDescription" rows="2" maxlength="1000">${escape(link?.expectedDescription)}</textarea><small>例如：提供 UI 设计素材、组件和界面灵感；使用网站实际采用的语言更有助于内容比对。</small></label>${field('预期内容关键词', 'expectedKeywords', (link?.expectedKeywords || []).join(', '), 'text', false, '用中文或英文逗号分隔，最多 12 个，每个不超过 80 字符。选择明确、稳定的名称或用途关键词。')}<div class="form-grid"><label class="field"><span>人工状态覆盖</span><select name="healthOverride"><option value="">使用自动检测结果</option>${overrides.map((state) => `<option value="${state}" ${link?.healthOverride === state ? 'selected' : ''}>${healthInfo(state).label} / ${state}</option>`).join('')}</select></label><div class="check-group">${checkbox('暂停此资源的自动检测', 'checkDisabled', link?.checkDisabled ?? false)}</div></div><label class="field"><span>管理员备注</span><textarea name="notes" rows="3" maxlength="4000">${escape(link?.notes)}</textarea><small>仅管理员可见，不会展示在前台。</small></label></details>`,
      '保存资源',
      async (form) => {
        const url = text(form, 'url');
        if (!safeUrl(url))
          throw new Error('请输入有效的 HTTP 或 HTTPS 地址，不要包含用户名与密码。');
        const iconMode = text(form, 'iconMode') as 'auto' | 'manual' | 'none';
        const iconValue =
          iconMode === 'manual' ? text(form, 'icon') : iconMode === 'none' ? '' : iconInput.value;
        if (!validIcon(iconValue))
          throw new Error('图标请输入 16 字符以内的短文字，或有效的 HTTPS 地址。');
        const expectedKeywords = text(form, 'expectedKeywords')
          .split(/[,，]/)
          .map((word) => word.trim())
          .filter(Boolean);
        if (expectedKeywords.length > 12 || expectedKeywords.some((word) => word.length > 80))
          throw new Error('预期关键词最多 12 个，每个不超过 80 字符。');
        const body = {
          name: text(form, 'name'),
          categoryId: text(form, 'categoryId'),
          url,
          description: text(form, 'description'),
          icon: iconValue,
          iconMode,
          sortOrder: Number(text(form, 'sortOrder')),
          enabled: checked(form, 'enabled'),
          featured: checked(form, 'featured'),
          healthOverride: text(form, 'healthOverride') || null,
          checkDisabled: checked(form, 'checkDisabled'),
          expectedKeywords,
          expectedTitle: text(form, 'expectedTitle'),
          expectedDescription: text(form, 'expectedDescription'),
          notes: text(form, 'notes'),
        };
        await write(
          link ? `/api/admin/links/${encodeURIComponent(link.id)}` : '/api/admin/links',
          link ? 'PUT' : 'POST',
          body,
        );
        await reload();
        toast('资源已保存');
      },
    );
    const modeSelect = element.querySelector<HTMLSelectElement>('[name="iconMode"]')!;
    const iconInput = element.querySelector<HTMLInputElement>('[name="icon"]')!;
    const urlInput = element.querySelector<HTMLInputElement>('[name="url"]')!;
    const nameInput = element.querySelector<HTMLInputElement>('[name="name"]')!;
    const refreshIcon = element.querySelector<HTMLButtonElement>('#refresh-icon');
    let iconLoading = false;
    function updateIconEditor(): void {
      const mode = modeSelect.value as 'auto' | 'manual' | 'none';
      iconInput.disabled = mode !== 'manual';
      iconInput.closest<HTMLElement>('.field')!.hidden = mode !== 'manual';
      const canRefresh = Boolean(
        link && savedIconMode === 'auto' && mode === 'auto' && urlInput.value.trim() === link.url,
      );
      if (refreshIcon) refreshIcon.disabled = !canRefresh || iconLoading;
      element.querySelector('#icon-mode-note')!.textContent =
        mode === 'manual'
          ? '人工图标会保留，只有你主动修改后才改变。'
          : mode === 'none'
            ? '显示网站名称首字，不请求外部图标。'
            : link && !canRefresh
              ? '切换到自动模式或修改网址后，请先保存资源再重新获取图标。'
              : `自动获取失败时显示名称首字。${link?.iconCheckedAt ? ` 最近获取：${formatDate(link.iconCheckedAt)}。` : ''}`;
      const preview = element.querySelector<HTMLElement>('#icon-preview')!;
      preview.innerHTML = siteIcon({
        name: nameInput.value || '网站',
        icon: iconInput.value,
        iconMode: mode,
      } as NavLink);
      bindImageFallback(preview);
    }
    modeSelect.addEventListener('change', updateIconEditor);
    iconInput.addEventListener('input', updateIconEditor);
    urlInput.addEventListener('input', updateIconEditor);
    nameInput.addEventListener('input', updateIconEditor);
    updateIconEditor();
    element.querySelector('#use-observed-title')?.addEventListener('click', () => {
      const input = element.querySelector<HTMLInputElement>('[name="expectedTitle"]')!;
      input.value = (link?.observedTitle || '').slice(0, 240);
      input.focus();
      toast('已填入预期 Title，保存资源后生效');
    });
    refreshIcon?.addEventListener('click', () => {
      if (!link) return;
      void action(async () => {
        iconLoading = true;
        const submit = element.querySelector<HTMLButtonElement>('[type="submit"]')!;
        submit.disabled = true;
        refreshIcon.textContent = '正在获取…';
        updateIconEditor();
        try {
          await write(`/api/admin/links/${encodeURIComponent(link.id)}/icon`, 'POST');
          await reload();
          const updated = data.links.find((item) => item.id === link.id);
          if (updated && modeSelect.value === 'auto' && urlInput.value.trim() === link.url) {
            iconInput.value = updated.icon;
            link.iconCheckedAt = updated.iconCheckedAt;
          }
          toast(updated?.icon ? '网站图标已更新' : '未发现可用图标，将显示名称首字');
        } finally {
          iconLoading = false;
          submit.disabled = false;
          refreshIcon.textContent = '重新获取';
          updateIconEditor();
        }
      });
    });
  }
  function deleteCategory(category: Category): void {
    const count = data.links.filter((link) => link.categoryId === category.id).length;
    if (count) {
      toast(`此分类下仍有 ${count} 个资源，请先移动或删除这些资源。`, true);
      return;
    }
    dialog(
      '删除分类',
      `<p class="confirm-message">删除「${escape(category.name)}」后，它将从导航中移除。建议在批量整理前导出备份。</p>`,
      '确认删除',
      async () => {
        const result = await write<{ ok: boolean; undoUrl?: string }>(
          `/api/admin/categories/${encodeURIComponent(category.id)}`,
          'DELETE',
        );
        await reload();
        deletedToast('分类已删除', result.undoUrl);
      },
      true,
    );
  }
  function deleteLink(link: ManagedLink): void {
    dialog(
      '删除导航资源',
      `<p class="confirm-message">确定删除「${escape(link.name)}」吗？此资源将从导航中移除。</p><p class="confirm-subtext">${escape(link.url)}</p>`,
      '确认删除',
      async () => {
        const result = await write<{ ok: boolean; undoUrl?: string }>(
          `/api/admin/links/${encodeURIComponent(link.id)}`,
          'DELETE',
        );
        await reload();
        deletedToast('资源已删除', result.undoUrl);
      },
      true,
    );
  }
  function deletedToast(message: string, undoUrl?: string): void {
    if (
      !undoUrl ||
      !/^\/api\/admin\/(categories|links)\/[a-zA-Z0-9_-]{1,80}\/restore$/.test(undoUrl)
    ) {
      toast(message);
      return;
    }
    document.querySelector('.toast')?.remove();
    const notification = document.createElement('div');
    notification.className = 'toast undo-toast';
    notification.setAttribute('role', 'status');
    const label = document.createElement('span');
    label.textContent = message;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'undo-button';
    undo.textContent = '撤销删除';
    undo.addEventListener('click', () => {
      void action(async () => {
        undo.disabled = true;
        try {
          await write(undoUrl, 'POST', {});
          await reload();
          notification.remove();
          toast('已恢复');
        } finally {
          undo.disabled = false;
        }
      });
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.setAttribute('aria-label', '关闭删除通知');
    close.innerHTML = icon('close');
    close.addEventListener('click', () => notification.remove());
    notification.append(label, undo, close);
    document.body.append(notification);
  }
  function healthDetails(link: ManagedLink): void {
    const similarity = contentInfo(link.contentStatus);
    const rows = [
      ['检测状态', `${healthInfo(link.healthStatus).label} (${link.healthStatus || 'unknown'})`],
      ['人工覆盖', link.healthOverride ? healthInfo(link.healthOverride).label : '未设置'],
      ['自动检测', link.checkDisabled ? '已暂停' : '已启用'],
      [
        '排队状态',
        link.healthPendingSettings
          ? `${link.healthNextRequestAt ? `最早 ${formatDate(new Date(link.healthNextRequestAt).toISOString())} 续查` : '等待自动恢复'}；启动参数 ${link.healthPendingSettings.healthIntervalSeconds} 秒间隔 / ${link.healthPendingSettings.healthTimeoutSeconds} 秒 Timeout`
          : '无待执行任务',
      ],
      ['上次检测', formatDate(link.lastCheckedAt)],
      ['HTTP 状态', httpLabel(link)],
      [
        '内容判断',
        `${similarity.label}${typeof link.similarityScore === 'number' ? ` · ${Math.round(link.similarityScore)}%` : ''}`,
      ],
      ['原始地址', link.url],
      ['最终地址', link.finalUrl || '—'],
      ['检测到的 Title', link.observedTitle || '未取得页面 Title'],
      ['预期 Title', link.expectedTitle || '未单独设置'],
      ['预期用途', link.expectedDescription || '未单独设置'],
      ['预期关键词', link.expectedKeywords?.join('、') || '未设置'],
      ['连续失败', String(link.consecutiveFailures || 0)],
      ['最近成功', formatDate(link.lastSuccessAt)],
      ['最近失败', formatDate(link.lastFailureAt)],
      ['检测信息', link.lastError || '无错误记录'],
    ];
    const element = dialog(
      `健康详情 · ${link.name}`,
      `<dl class="health-detail-list">${rows.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${link.redirectChain?.length ? `<section class="health-detail-section"><h3>HTTP 跳转记录</h3><ol class="redirect-chain">${link.redirectChain.map((hop) => `<li><strong>HTTP ${hop.status}</strong><span>${escape(hop.url)}</span>${hop.location ? `<small>→ ${escape(hop.location)}</small>` : ''}</li>`).join('')}</ol></section>` : ''}${link.healthEvidence?.length ? `<section class="health-detail-section"><h3>判断依据</h3><ul class="health-evidence">${link.healthEvidence.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></section>` : ''}<details class="health-history"><summary>最近检测历史与实际使用参数</summary><div id="health-history-results"><p class="field-note">正在读取历史…</p></div></details><p class="field-note">相似度是轻量内容线索，不是网站真实性保证。403、429、验证码或机器人防护并不代表网站已失效。自动判断不确定时，请结合实际访问进行人工复核。</p>`,
      '重新检测',
      async () => {
        const response = await write<{ queued?: boolean; nextRequestAt?: string | null }>(
          `/api/admin/links/${encodeURIComponent(link.id)}/check`,
          'POST',
        );
        await reload();
        toast(
          response.queued
            ? `检测已排队${response.nextRequestAt ? `，最早 ${formatDate(response.nextRequestAt)} 续查` : '，自动恢复后请刷新查看'}`
            : '健康检测已完成',
        );
      },
    );
    const edit = document.createElement('button');
    edit.className = 'button secondary';
    edit.type = 'button';
    edit.textContent = '编辑检测设置';
    edit.addEventListener('click', () => {
      element.close();
      editLink(link);
    });
    element.querySelector('.dialog-footer')!.prepend(edit);
    void api<HealthHistory[]>(`/api/admin/links/${encodeURIComponent(link.id)}/history`)
      .then((history) => {
        const target = element.querySelector('#health-history-results');
        if (!target) return;
        target.innerHTML = history.length
          ? history
              .slice(0, 5)
              .map(
                (item) =>
                  `<article class="history-entry"><div><strong>${escape(formatDate(item.checkedAt))}</strong><span>${escape(healthInfo(item.status).label)} · ${item.httpStatus ? `HTTP ${item.httpStatus}` : escape(httpLabel({ healthStatus: item.status, lastCheckedAt: item.checkedAt } as NavLink))}</span></div><p>${escape(contentInfo(item.contentStatus).label)}${typeof item.similarityScore === 'number' ? ` · ${Math.round(item.similarityScore)}%` : ''}</p>${item.probeUserAgent ? `<dl><div><dt>User-Agent</dt><dd>${escape(item.probeUserAgent)}</dd></div><div><dt>请求间隔 / Timeout</dt><dd>${escape(item.probeIntervalSeconds)} 秒 / ${escape(item.probeTimeoutSeconds)} 秒</dd></div></dl>` : '<p class="field-note">此历史记录未保存探测参数。</p>'}</article>`,
              )
              .join('')
          : '<p class="field-note">尚无检测历史。</p>';
      })
      .catch((error: Error) => {
        const target = element.querySelector('#health-history-results');
        if (target) target.textContent = error.message;
      });
  }
  async function exportData(): Promise<void> {
    const exported = await api<{ version: number; categories: unknown[]; links: unknown[] }>(
      '/api/admin/export',
    );
    const parts = createBackupParts(exported);
    const basename = `cf-nav-backup-${new Date().toISOString().slice(0, 10)}`;
    if (parts.length === 1) {
      downloadPart(parts[0]!, `${basename}.json`);
      toast('JSON 备份已导出');
      return;
    }
    const element = dialog(
      '分片备份下载',
      `<p class="confirm-message">此备份已拆分为 ${parts.length} 份可独立导入的 JSON 文件。</p><p class="field-note">请逐个下载并保留全部分片。恢复时按编号逐个合并导入，每份都包含完整分类，现有内容会保留。</p><div class="backup-parts">${parts.map((part, index) => `<button type="button" class="button secondary backup-part" data-part="${index}">${icon('download')}分片 ${index + 1} / ${parts.length}<span>${part.linkCount} 个资源 · ${(part.bytes / 1024 / 1024).toFixed(2)} MiB</span></button>`).join('')}</div>`,
      '完成',
      async () => {},
    );
    element.querySelectorAll<HTMLButtonElement>('[data-part]').forEach((button) =>
      button.addEventListener('click', () => {
        const index = Number(button.dataset.part);
        downloadPart(
          parts[index]!,
          `${basename}-part-${String(index + 1).padStart(3, '0')}-of-${parts.length}.json`,
        );
        button.classList.add('download-requested');
        button.setAttribute('aria-label', `分片 ${index + 1} 已请求下载，可再次下载`);
      }),
    );
  }
  function downloadPart(part: BackupPart, filename: string): void {
    const blob = new Blob([part.contents], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importData(): void {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.addEventListener('change', () => {
      void action(async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES)
          throw new Error('备份文件不能超过 8 MiB。大型备份请逐个选择导出时生成的分片文件。');
        let imported: { version?: number; categories?: unknown[]; links?: unknown[] };
        try {
          imported = JSON.parse(await file.text()) as typeof imported;
        } catch {
          throw new Error('无法解析此 JSON 文件，请选择有效的导航备份。');
        }
        if (
          !imported ||
          imported.version !== 1 ||
          !Array.isArray(imported.categories) ||
          !Array.isArray(imported.links)
        )
          throw new Error('备份需要包含 version: 1、categories 和 links。');
        dialog(
          '导入导航备份',
          `<p class="confirm-message">准备导入「${escape(file.name)}」</p><div class="import-summary"><strong>${imported.categories.length}<span>个分类</span></strong><strong>${imported.links.length}<span>个资源</span></strong></div><p class="field-note">将按 ID 合并分类与资源，同 ID 的内容会更新；备份中未包含的现有条目会保留。请确认备份来源可信，建议先导出当前数据。</p>`,
          '合并导入',
          async () => {
            await write('/api/admin/import', 'POST', { ...imported, mode: 'merge' });
            await reload();
            toast('备份已导入');
          },
        );
      });
    });
    fileInput.click();
  }
}
