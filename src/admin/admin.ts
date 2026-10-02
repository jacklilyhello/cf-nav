import {
  api,
  bindImageFallback,
  brand,
  escape,
  formatDate,
  healthBadge,
  healthInfo,
  hostname,
  icon,
  safeUrl,
  siteIcon,
  toast,
  type Catalog,
  type Category,
  type NavLink,
} from '../frontend/ui';

type ManagedLink = NavLink & { expectedKeywords?: string[] };
type AdminCatalog = Omit<Catalog, 'links'> & { links: ManagedLink[] };
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
  app.innerHTML = `<main class="standalone" id="main">${brand()}<div class="empty-state"><span class="loading-indicator"></span><h2>正在验证管理员身份</h2><p>安全连接建立后，即可管理你的数字花园。</p></div></main>`;
  let session: Session;
  let data: AdminCatalog;
  let activeTab = 'links';
  let search = '';
  let categoryFilter = '';
  let statusFilter = '';
  try {
    const response = await fetch('/api/admin/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const body = (await response.json()) as Session & { error?: string; loginUrl?: string };
    if (!response.ok || !body.authenticated) {
      app.innerHTML = `<main class="standalone" id="main">${brand()}<section class="login-panel"><span class="login-symbol">${icon('shield')}</span><span class="eyebrow">A PRIVATE SPACE TO CURATE</span><h1>打理你的数字花园。</h1><p>这里是 Lily 寻迹的私人管理空间。<br />通过管理员身份验证后，管理资源、分类与链接健康状态。</p><a class="button primary" href="/admin/login">${icon('shield')}通过 Cloudflare Access 登录${icon('arrow')}</a><span class="login-note">仅限站点管理员 · 安全身份验证</span><a class="back-home" href="/">返回公开导航</a></section></main>`;
      return;
    }
    session = body;
    data = await api<AdminCatalog>('/api/admin/data');
  } catch (error) {
    app.innerHTML = `<main class="standalone" id="main">${brand()}<div class="empty-state">${icon('warning')}<h1>暂时无法连接管理服务</h1><p>${escape((error as Error).message)}</p><button class="button secondary" id="reload-admin">重新连接</button></div></main>`;
    document.querySelector('#reload-admin')?.addEventListener('click', () => {
      void mountAdmin(app);
    });
    return;
  }
  sortData();
  app.innerHTML = `<div class="admin-layout"><aside class="admin-sidebar">${brand()}<span class="admin-space-label">PRIVATE WORKSPACE</span><nav aria-label="管理菜单"><button class="admin-nav active" data-tab="links">${icon('link')}导航资源</button><button class="admin-nav" data-tab="categories">${icon('folder')}分类管理</button><button class="admin-nav" data-tab="health">${icon('shield')}健康检测</button></nav><div class="admin-sidebar-bottom"><a class="admin-nav" href="/">${icon('arrow')}打开前台</a><div class="session-info">${icon('shield')}<span>已安全登录<small>${escape(session.email)}</small></span></div><button class="admin-nav" id="logout">${icon('logout')}退出登录</button></div></aside><div class="admin-workspace"><header class="admin-topbar"><span>管理控制台 <span class="slash">/</span> <span id="admin-breadcrumb">导航资源</span></span><a href="/">查看站点 ${icon('arrow')}</a></header><main id="main" class="admin-main"><div class="admin-heading"><div><span class="eyebrow">CURATE YOUR DIGITAL GARDEN</span><h1 id="admin-title">导航资源</h1><p id="admin-description">让每一个收藏，都有值得留下的理由。</p></div><div class="admin-actions"><button class="button secondary" id="export-data">${icon('download')}导出</button><button class="button secondary" id="import-data">${icon('upload')}导入</button><button class="button primary" id="add-item">${icon('plus')}新增资源</button></div></div><div class="admin-stats" id="admin-stats"></div><div class="admin-panel"><div class="admin-filters"><div class="admin-search">${icon('search')}<label class="visually-hidden" for="admin-search">搜索资源或分类</label><input id="admin-search" type="search" placeholder="搜索名称、网址或分类…" autocomplete="off" /></div><label class="visually-hidden" for="category-filter">筛选分类</label><select id="category-filter"><option value="">全部分类</option></select><label class="visually-hidden" for="status-filter">筛选状态</label><select id="status-filter"><option value="">全部状态</option><option value="enabled">前台显示</option><option value="hidden">已隐藏</option><option value="featured">精选推荐</option><option value="review">需要关注</option></select><button class="icon-button" id="refresh-data" aria-label="刷新管理数据">${icon('refresh')}</button></div><div id="admin-list" aria-live="polite"></div><div class="admin-list-footer" id="admin-list-footer"></div></div><p class="admin-footnote">内容修改保存后即生效。健康检测结果供维护参考；访问受限不等于网站失效。</p></main></div></div>`;
  const searchInput = document.querySelector<HTMLInputElement>('#admin-search')!;
  const categorySelect = document.querySelector<HTMLSelectElement>('#category-filter')!;
  const statusSelect = document.querySelector<HTMLSelectElement>('#status-filter')!;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
    button.addEventListener('click', () => {
      activeTab = button.dataset.tab!;
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
      toast((error as Error).message, true);
    }
  }
  async function reload(): Promise<void> {
    data = await api<AdminCatalog>('/api/admin/data');
    sortData();
    render();
  }
  function render(): void {
    const title =
      activeTab === 'categories' ? '分类管理' : activeTab === 'health' ? '健康检测' : '导航资源';
    document.querySelector('#admin-title')!.textContent = title;
    document.querySelector('#admin-breadcrumb')!.textContent = title;
    document.querySelector('#admin-description')!.textContent =
      activeTab === 'categories'
        ? '为你的收藏整理秩序，让发现变得轻松。'
        : activeTab === 'health'
          ? '关注变化与异常，让收藏始终值得信赖。'
          : '让每一个收藏，都有值得留下的理由。';
    document.querySelector('#add-item')!.innerHTML =
      `${icon('plus')}${activeTab === 'categories' ? '新增分类' : '新增资源'}`;
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
      `<div><span>收藏资源</span><strong>${data.links.length}<small>个</small></strong></div><div><span>前台显示</span><strong>${data.links.filter((link) => link.enabled && data.categories.find((category) => category.id === link.categoryId)?.enabled).length}<small>个</small></strong></div><div><span>内容分类</span><strong>${data.categories.length}<small>组</small></strong></div><div><span>需要关注</span><strong class="attention-number">${reviewCount}<small>项</small></strong></div>`;
    renderList();
  }
  function needsAttention(link: ManagedLink): boolean {
    const state = healthInfo(link.healthOverride || link.healthStatus).tone;
    return !link.checkDisabled && ['review', 'bad'].includes(state);
  }
  function renderList(): void {
    const list = document.querySelector<HTMLDivElement>('#admin-list')!;
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
          (statusFilter === 'enabled' && link.enabled) ||
          (statusFilter === 'hidden' && !link.enabled) ||
          (statusFilter === 'featured' && link.featured) ||
          (statusFilter === 'review' && needsAttention(link)))
      );
    });
    list.innerHTML = links.length
      ? `<div class="admin-row row-label"><span>资源 / 网址</span><span>所属分类</span><span>${activeTab === 'health' ? '检测状态 / 时间' : '状态'}</span><span>操作</span></div>${links.map((link) => `<div class="admin-row"><div class="admin-item-name">${siteIcon(link)}<div><strong>${escape(link.name)}${link.featured ? `<span class="inline-star" title="精选推荐">${icon('star')}</span>` : ''}${!link.enabled ? '<span class="hidden-tag">隐藏</span>' : ''}</strong><a href="${escape(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer">${escape(hostname(link.url))} ${icon('arrow')}</a></div></div><span class="row-meta row-category">${escape(data.categories.find((category) => category.id === link.categoryId)?.name || '未分类')}</span><button class="health-details" data-health="${escape(link.id)}" aria-label="查看 ${escape(link.name)} 的健康详情">${healthBadge(link)}${activeTab === 'health' ? `<small>${escape(formatDate(link.lastCheckedAt))}</small>` : ''}</button><div class="row-actions">${activeTab === 'health' ? `<button class="icon-button" data-check="${escape(link.id)}" aria-label="重新检测 ${escape(link.name)}">${icon('refresh')}</button>` : ''}<button class="icon-button" data-edit-link="${escape(link.id)}" aria-label="编辑 ${escape(link.name)}">${icon('edit')}</button><button class="icon-button danger-icon" data-delete-link="${escape(link.id)}" aria-label="删除 ${escape(link.name)}">${icon('trash')}</button></div></div>`).join('')}`
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
            await write(
              `/api/admin/links/${encodeURIComponent(button.dataset.check!)}/check`,
              'POST',
            );
            await reload();
            toast('健康检测已完成');
          } finally {
            button.disabled = false;
          }
        });
      }),
    );
    document.querySelector('#admin-list-footer')!.textContent =
      `${links.length} 个资源 · 点击健康状态查看检测详情`;
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
    return `<label class="field"><span>${label}${required ? '<b>*</b>' : ''}</span><input name="${name}" type="${type}" value="${escape(value)}" ${required ? 'required' : ''} ${type === 'number' ? 'min="0" max="1000000" step="1"' : 'maxlength="2000"'} />${hint ? `<small>${hint}</small>` : ''}</label>`;
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
    dialog(
      link ? '编辑导航资源' : '新增导航资源',
      `<div class="form-grid">${field('网站名称', 'name', link?.name, 'text', true)}<label class="field"><span>所属分类<b>*</b></span><select name="categoryId" required>${data.categories.map((category) => `<option value="${escape(category.id)}" ${category.id === link?.categoryId ? 'selected' : ''}>${escape(category.name)}${!category.enabled ? '（隐藏）' : ''}</option>`).join('')}</select></label></div>${field('网站地址', 'url', link?.url || 'https://', 'url', true)}<label class="field"><span>简介</span><textarea name="description" rows="2" maxlength="1000">${escape(link?.description)}</textarea></label><div class="form-grid">${field('图标地址', 'icon', link?.icon || '', 'url', false, '可选 HTTPS 图标；留空显示名称首字。')}${field('排序值', 'sortOrder', String(link?.sortOrder ?? data.links.length * 10), 'number', true)}</div><div class="checkbox-row">${checkbox('前台显示', 'enabled', link?.enabled ?? true)}${checkbox('精选推荐', 'featured', link?.featured ?? false)}</div><details class="advanced-fields" ${link ? 'open' : ''}><summary>健康检测与维护</summary><div class="form-grid"><label class="field"><span>人工状态覆盖</span><select name="healthOverride"><option value="">使用自动检测结果</option>${overrides.map((state) => `<option value="${state}" ${link?.healthOverride === state ? 'selected' : ''}>${healthInfo(state).label} / ${state}</option>`).join('')}</select></label><div class="check-group">${checkbox('暂停此资源的自动检测', 'checkDisabled', link?.checkDisabled ?? false)}</div></div>${field('预期内容关键词', 'expectedKeywords', (link?.expectedKeywords || []).join(', '), 'text', false, '用英文逗号分隔，用于辅助识别服务或内容变化。')}<label class="field"><span>管理员备注</span><textarea name="notes" rows="3" maxlength="4000">${escape(link?.notes)}</textarea><small>仅管理员可见，不会展示在前台。</small></label></details>`,
      '保存资源',
      async (form) => {
        const url = text(form, 'url');
        if (!safeUrl(url))
          throw new Error('请输入有效的 HTTP 或 HTTPS 地址，不要包含用户名与密码。');
        const iconUrl = text(form, 'icon');
        if (iconUrl && (!safeUrl(iconUrl) || !iconUrl.startsWith('https://')))
          throw new Error('图标地址需要使用 HTTPS。');
        const body = {
          name: text(form, 'name'),
          categoryId: text(form, 'categoryId'),
          url,
          description: text(form, 'description'),
          icon: iconUrl,
          sortOrder: Number(text(form, 'sortOrder')),
          enabled: checked(form, 'enabled'),
          featured: checked(form, 'featured'),
          healthOverride: text(form, 'healthOverride') || null,
          checkDisabled: checked(form, 'checkDisabled'),
          expectedKeywords: text(form, 'expectedKeywords')
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean),
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
    const rows = [
      ['检测状态', `${healthInfo(link.healthStatus).label} (${link.healthStatus || 'unknown'})`],
      ['人工覆盖', link.healthOverride ? healthInfo(link.healthOverride).label : '未设置'],
      ['自动检测', link.checkDisabled ? '已暂停' : '已启用'],
      ['上次检测', formatDate(link.lastCheckedAt)],
      ['HTTP 状态', link.httpStatus ? String(link.httpStatus) : '—'],
      ['最终地址', link.finalUrl || '—'],
      ['连续失败', String(link.consecutiveFailures || 0)],
      ['最近成功', formatDate(link.lastSuccessAt)],
      ['最近失败', formatDate(link.lastFailureAt)],
      ['检测信息', link.lastError || '无错误记录'],
    ];
    const element = dialog(
      `健康详情 · ${link.name}`,
      `<dl class="health-detail-list">${rows.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p class="field-note">403、429、验证码或机器人防护并不代表网站已失效。自动判断不确定时，请结合实际访问进行人工复核。</p>`,
      '重新检测',
      async () => {
        await write(`/api/admin/links/${encodeURIComponent(link.id)}/check`, 'POST');
        await reload();
        toast('健康检测已完成');
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
  }
  async function exportData(): Promise<void> {
    const exported = await api<unknown>('/api/admin/export');
    const blob = new Blob([JSON.stringify(exported, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cf-nav-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('JSON 备份已导出');
  }
  function importData(): void {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.addEventListener('change', () => {
      void action(async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) throw new Error('备份文件不能超过 5 MB。');
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
