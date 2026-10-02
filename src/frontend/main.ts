import './styles.css';
import {
  api,
  bindImageFallback,
  brand,
  categoryIcon,
  escape,
  healthBadge,
  hostname,
  icon,
  safeUrl,
  siteIcon,
  type Catalog,
  type NavLink,
} from './ui';

const app = document.querySelector<HTMLDivElement>('#app')!;
if (location.pathname.replace(/\/$/, '') === '/admin') {
  void import('../admin/admin').then(({ mountAdmin }) => mountAdmin(app));
} else if (location.pathname !== '/') {
  app.innerHTML = `<main id="main" class="standalone">${brand()}<div class="empty-state">${icon('globe')}<span class="eyebrow">404 / LOST IN THE MIST</span><h1>这条小径，还未抵达。</h1><p>页面可能已移动，回到首页继续探索。</p><a class="button primary" href="/">返回导航</a></div></main>`;
} else {
  void mountCatalog();
}

async function mountCatalog(): Promise<void> {
  let catalog: Catalog;
  let activeCategory = 'all';
  let filter = 'all';
  let query = '';
  app.innerHTML = `<div class="site-layout"><aside class="sidebar" id="sidebar">${brand()}<div class="sidebar-intro">收藏好去处 · 连接新可能</div><nav aria-label="资源分类" id="category-nav"><div class="skeleton nav-skeleton"></div><div class="skeleton nav-skeleton"></div><div class="skeleton nav-skeleton"></div></nav><div class="sidebar-bottom"><div class="sidebar-note"><span class="tiny-orbit"></span><span>在信息之间，<br />留一点探索的余地。</span></div><a class="admin-link" href="/admin">${icon('shield')}<span>管理控制台</span>${icon('arrow')}</a><div class="owner">CRAFTED FOR <a href="https://lily.lat/" target="_blank" rel="noopener noreferrer">LILY.LAT</a></div></div></aside><button class="sidebar-overlay" type="button" aria-label="关闭分类菜单" hidden></button><div class="workspace"><header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" type="button" aria-label="打开分类菜单" aria-controls="sidebar" aria-expanded="false">${icon('menu')}</button><span>我的数字花园</span><span class="slash">/</span><span class="breadcrumb-active">探索</span></div><div class="topbar-right"><span class="ambient-status"><i></i> 保持好奇，持续探索</span><a class="topbar-admin" href="/admin" aria-label="管理控制台">${icon('shield')}</a></div></header><main id="main"><section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><div class="eyebrow"><span></span> A QUIETER CORNER OF THE INTERNET</div><h1 id="hero-title">让每一次探索，<br />都有<span>迹可循。</span></h1><p>一些好用的工具，一些值得停留的地方。<br class="desktop-break" />在纷繁的数字世界里，找到你的下一站。</p><div class="hero-caption"><span class="caption-line"></span> 精选 · 有序 · 常新</div></div><div class="landscape" aria-hidden="true"><svg viewBox="0 0 700 330" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="mountain-back" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#3A506B" stop-opacity=".65"/><stop offset="1" stop-color="#15232D" stop-opacity="0"/></linearGradient><linearGradient id="mountain-front" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#2F6F73" stop-opacity=".5"/><stop offset="1" stop-color="#0B0F14" stop-opacity="0"/></linearGradient><radialGradient id="sun-haze"><stop stop-color="#D9C19A" stop-opacity=".11"/><stop offset="1" stop-color="#D9C19A" stop-opacity="0"/></radialGradient></defs><circle cx="489" cy="82" r="81" fill="url(#sun-haze)"/><circle cx="489" cy="82" r="23" fill="none" stroke="#D9C19A" stroke-opacity=".55" stroke-width=".7"/><path d="M-20 302 155 135 200 176 308 60 425 180 510 107 700 284V330H0Z" fill="url(#mountain-back)"/><path d="m-20 302 175-167 45 41L308 60l117 120 85-73 190 177" fill="none" stroke="#66869A" stroke-opacity=".25"/><path d="m30 330 188-134 61 54 112-128 183 178 103-63 123 93Z" fill="url(#mountain-front)"/><path d="m30 330 188-134 61 54 112-128 183 178 103-63 123 93" fill="none" stroke="#7FC0C6" stroke-opacity=".28"/><path d="M45 274c138-37 198 50 370 4s166-18 287 7M91 293c109-14 147 41 320 6s156-22 264-7" fill="none" stroke="#7FC0C6" stroke-opacity=".1"/><circle cx="308" cy="60" r="2.5" fill="#7FC0C6" fill-opacity=".5"/><path d="M308 60v51m-8-41h17" stroke="#7FC0C6" stroke-opacity=".14"/><path d="M583 89h24m-12-12v24" stroke="#D9C19A" stroke-opacity=".3"/></svg><span class="landscape-label">山有迹 · 心无界</span></div></section><section class="search-region" aria-label="搜索资源"><div class="search-box">${icon('search')}<label class="visually-hidden" for="resource-search">搜索名称、网址、简介或分类</label><input id="resource-search" type="search" autocomplete="off" placeholder="搜索灵感、工具，或下一个好去处…" /><button id="clear-search" class="icon-button" type="button" aria-label="清空搜索" hidden>${icon('close')}</button><kbd class="search-shortcut">⌘ K</kbd></div><div class="search-hint">搜索名称、网址、简介或分类<span id="catalog-count"></span></div></section><section class="catalog-section" aria-label="资源导航"><div class="section-toolbar"><div class="filter-tabs" role="group" aria-label="资源筛选"><button class="filter-tab active" data-filter="all" aria-pressed="true">${icon('grid')}全部资源</button><button class="filter-tab" data-filter="featured" aria-pressed="false">${icon('star')}精选推荐</button></div><span class="result-count" id="result-count" aria-live="polite"></span></div><div id="catalog-results" aria-busy="true"><div class="loading-grid">${Array.from({ length: 6 }, () => '<div class="skeleton card-skeleton"></div>').join('')}</div></div></section><footer class="site-footer"><span><strong>Lily · 寻迹</strong> <span class="footer-divider">/</span> 连接值得发现的世界</span><span>用心收藏，慢慢探索 <span class="footer-dot">✦</span></span></footer></main></div></div>`;
  const input = document.querySelector<HTMLInputElement>('#resource-search')!;
  const clear = document.querySelector<HTMLButtonElement>('#clear-search')!;
  const results = document.querySelector<HTMLDivElement>('#catalog-results')!;
  const menu = document.querySelector<HTMLButtonElement>('.mobile-menu')!;
  const overlay = document.querySelector<HTMLButtonElement>('.sidebar-overlay')!;
  const toggleMenu = (open: boolean): void => {
    document.body.classList.toggle('menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    overlay.hidden = !open;
  };
  menu.addEventListener('click', () => toggleMenu(menu.getAttribute('aria-expanded') !== 'true'));
  overlay.addEventListener('click', () => toggleMenu(false));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
    }
    if (event.key === 'Escape') toggleMenu(false);
    if (
      event.key === '/' &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)
    ) {
      event.preventDefault();
      input.focus();
    }
  });
  input.addEventListener('input', () => {
    query = input.value.trim().toLocaleLowerCase();
    clear.hidden = !query;
    if (catalog) renderResults();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    query = '';
    clear.hidden = true;
    renderResults();
    input.focus();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      filter = button.dataset.filter!;
      document.querySelectorAll('[data-filter]').forEach((tab) => {
        const active = (tab as HTMLElement).dataset.filter === filter;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-pressed', String(active));
      });
      if (catalog) renderResults();
    }),
  );
  async function load(): Promise<void> {
    try {
      catalog = await api<Catalog>('/api/catalog');
      catalog.categories.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      catalog.links.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      renderNav();
      renderResults();
      document.querySelector('#catalog-count')!.textContent =
        `${catalog.links.length} 个资源 · ${catalog.categories.length} 个分类`;
    } catch {
      results.innerHTML = `<div class="empty-state">${icon('warning')}<h2>暂时无法载入资源</h2><p>连接似乎有些不顺，稍后再试一次。</p><button class="button secondary" id="retry-load">${icon('refresh')}重新加载</button></div>`;
      document.querySelector('#retry-load')?.addEventListener('click', () => {
        void load();
      });
      document.querySelector('#category-nav')!.innerHTML =
        '<p class="muted nav-unavailable">分类暂不可用</p>';
    } finally {
      results.setAttribute('aria-busy', 'false');
    }
  }
  function renderNav(): void {
    const counts = new Map<string, number>();
    for (const link of catalog.links)
      counts.set(link.categoryId, (counts.get(link.categoryId) || 0) + 1);
    document.querySelector('#category-nav')!.innerHTML =
      `<button class="nav-item ${activeCategory === 'all' ? 'active' : ''}" data-category="all" aria-pressed="${activeCategory === 'all'}">${icon('grid')}<span>发现全部</span><small>${catalog.links.length}</small></button><div class="nav-label">探索分类 <span>COLLECTIONS</span></div>${catalog.categories.map((category, index) => `<button class="nav-item ${activeCategory === category.id ? 'active' : ''}" data-category="${escape(category.id)}" aria-pressed="${activeCategory === category.id}">${icon(categoryIcon(category, index))}<span>${escape(category.name)}</span><small>${counts.get(category.id) || 0}</small></button>`).join('')}`;
    document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) =>
      button.addEventListener('click', () => {
        activeCategory = button.dataset.category!;
        renderNav();
        renderResults();
        toggleMenu(false);
        document.querySelector('.breadcrumb-active')!.textContent =
          activeCategory === 'all'
            ? '探索'
            : catalog.categories.find((category) => category.id === activeCategory)!.name;
      }),
    );
  }
  function card(link: NavLink): string {
    const url = safeUrl(link.url);
    return `<a class="resource-card" href="${escape(url || '#')}" target="_blank" rel="noopener noreferrer" aria-label="打开 ${escape(link.name)}（新标签页）"><div class="card-top">${siteIcon(link)}<div class="card-heading"><h3>${escape(link.name)}</h3><span>${escape(hostname(link.url))}</span></div><span class="card-open">${icon('arrow')}</span></div><p class="card-description">${escape(link.description || '发现更多值得探索的内容。')}</p><div class="card-bottom">${healthBadge(link)}${link.featured ? `<span class="featured-mark">${icon('star')}精选</span>` : `<span class="card-visit">前往探索 ${icon('chevron')}</span>`}</div></a>`;
  }
  function renderResults(): void {
    const categories = new Map(catalog.categories.map((category) => [category.id, category]));
    const links = catalog.links.filter((link) => {
      const category = categories.get(link.categoryId);
      return (
        (activeCategory === 'all' || link.categoryId === activeCategory) &&
        (filter !== 'featured' || link.featured) &&
        (!query ||
          [link.name, link.description, hostname(link.url), category?.name || '']
            .join(' ')
            .toLocaleLowerCase()
            .includes(query))
      );
    });
    document.querySelector('#result-count')!.textContent = `${links.length} 个发现`;
    if (!links.length) {
      results.innerHTML = `<div class="empty-state">${icon(query ? 'search' : 'folder')}<h2>${query ? '还没有找到这个好去处' : filter === 'featured' ? '精选正在慢慢积累' : '一片等待探索的新天地'}</h2><p>${query ? '试试其他关键词，或切换分类继续探索。' : '值得收藏的资源会在这里相遇。'}</p>${query || activeCategory !== 'all' || filter !== 'all' ? '<button class="button secondary" id="reset-filters">查看全部资源</button>' : ''}</div>`;
      document.querySelector('#reset-filters')?.addEventListener('click', () => {
        activeCategory = 'all';
        filter = 'all';
        query = '';
        input.value = '';
        clear.hidden = true;
        document.querySelector<HTMLButtonElement>('[data-filter="all"]')!.click();
        renderNav();
        renderResults();
        document.querySelector('.breadcrumb-active')!.textContent = '探索';
      });
      return;
    }
    if (query) {
      results.innerHTML = `<div class="category-heading"><div><span class="section-kicker">SEARCH RESULTS</span><h2>搜索结果 <span>“${escape(input.value.trim())}”</span></h2></div></div><div class="cards-grid">${links.map(card).join('')}</div>`;
    } else {
      results.innerHTML = catalog.categories
        .filter((category) => links.some((link) => link.categoryId === category.id))
        .map(
          (category, index) =>
            `<section class="resource-group" aria-labelledby="group-${escape(category.id)}"><div class="category-heading"><div class="category-title-group"><span class="category-symbol">${icon(categoryIcon(category, index))}</span><div><h2 id="group-${escape(category.id)}">${escape(category.name)}<span>${links
              .filter((link) => link.categoryId === category.id)
              .length.toString()
              .padStart(
                2,
                '0',
              )}</span></h2>${category.description ? `<p>${escape(category.description)}</p>` : ''}</div></div><span class="category-line"></span></div><div class="cards-grid">${links
              .filter((link) => link.categoryId === category.id)
              .map(card)
              .join('')}</div></section>`,
        )
        .join('');
    }
    bindImageFallback(results);
  }
  await load();
}
