/** Match the hostname portion of a Workers route, including zone-wide wildcards. */
export function routeMatchesHostname(pattern, hostname) {
  const authority = String(pattern)
    .replace(/^[a-z*]+:\/\//i, '')
    .split('/')[0]
    .toLowerCase();
  const escaped = authority.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i').test(hostname);
}

const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
const quote = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return String(Number(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Seed contains an invalid numeric value');
    return String(value);
  }
  return `'${String(Array.isArray(value) ? JSON.stringify(value) : value).replaceAll("'", "''")}'`;
};

/** Generate only guarded inserts. Wrangler imports the file in one transaction. */
export function buildSeedSql(data, now) {
  if (
    data?.version !== 1 ||
    !Array.isArray(data.categories) ||
    !Array.isArray(data.links) ||
    data.categories.length < 1 ||
    data.categories.length > 100 ||
    data.links.length < 1 ||
    data.links.length > 1000
  )
    throw new Error('Seed must contain nonempty, bounded version-1 categories and links');
  const categoryIds = new Set(data.categories.map((item) => item.id));
  if (
    categoryIds.size !== data.categories.length ||
    new Set(data.categories.map((item) => item.slug || item.id)).size !== data.categories.length ||
    new Set(data.links.map((item) => item.id)).size !== data.links.length ||
    new Set(data.links.map((item) => item.url)).size !== data.links.length
  )
    throw new Error('Seed IDs, category slugs and link URLs must be unique');
  const sql = [];
  const emit = (table, row) =>
    sql.push(
      `INSERT INTO ${table}(${Object.keys(row).join(',')}) SELECT ${Object.values(row).map(quote).join(',')} WHERE NOT EXISTS(SELECT 1 FROM metadata WHERE key='seed-imported');`,
    );
  for (const category of data.categories) {
    if (
      !identifier.test(category.id) ||
      typeof category.name !== 'string' ||
      !category.name.trim()
    ) {
      throw new Error('Seed category is malformed');
    }
    emit('categories', {
      id: category.id,
      name: category.name,
      slug: category.slug || category.id,
      description: category.description || '',
      sortOrder: category.sortOrder || 0,
      enabled: category.enabled !== false,
      updatedAt: now,
    });
  }
  for (const link of data.links) {
    if (
      !identifier.test(link.id) ||
      !categoryIds.has(link.categoryId) ||
      typeof link.name !== 'string' ||
      !link.name.trim()
    ) {
      throw new Error('Seed link is malformed or references a missing category');
    }
    const target = new URL(link.url);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Seed contains an invalid navigation URL');
    }
    const successful = ['healthy', 'redirected', 'moved'].includes(link.healthStatus);
    emit('links', {
      id: link.id,
      categoryId: link.categoryId,
      name: link.name,
      url: link.url,
      description: link.description || '',
      icon: link.icon || '',
      sortOrder: link.sortOrder || 0,
      enabled: link.enabled !== false,
      featured: !!link.featured,
      notes: link.notes || '',
      expectedKeywords: link.expectedKeywords || [],
      healthStatus: link.healthStatus || 'unknown',
      healthOverride: link.healthOverride || null,
      checkDisabled: !!link.checkDisabled,
      lastCheckedAt: link.lastCheckedAt || null,
      lastSuccessAt: successful ? link.lastSuccessAt || null : null,
      lastFailureAt: link.lastFailureAt || null,
      nextCheckAt: '1970-01-01T00:00:00.000Z',
      consecutiveFailures: link.consecutiveFailures || 0,
      lastError: link.lastError || null,
      observedTitle: link.observedTitle || null,
      confirmedTitle: successful ? link.observedTitle || null : null,
      healthEvidence: link.healthEvidence || [],
      finalUrl: link.finalUrl || null,
      httpStatus: link.httpStatus || null,
      updatedAt: now,
    });
  }
  sql.push(`INSERT OR IGNORE INTO metadata(key,value) VALUES('seed-imported',${quote(now)});`);
  return `${sql.join('\n')}\n`;
}

export async function waitForDeploymentHealth(requestHealth, expectedVersion, options = {}) {
  const now = options.now || Date.now;
  const delay =
    options.delay ||
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.maxWaitMs ?? 90_000);
  let reason = 'unavailable';
  while (now() < deadline) {
    let response;
    try {
      response = await requestHealth(Math.max(1, deadline - now()));
    } catch (error) {
      if (!(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error?.name))
        throw error;
      reason = 'network not ready';
    }
    if (response) {
      if (response.status === 200) {
        const state = await response.json();
        if (state.app !== 'cf-nav' || state.ok !== true)
          throw new Error('Wrong Worker health contract');
        if (!expectedVersion || state.version === expectedVersion) return state;
        reason = 'previous source version';
      } else {
        await response.body?.cancel();
        if (![404, 503].includes(response.status)) throw new Error(`Health ${response.status}`);
        reason = `Health ${response.status}`;
      }
    }
    if (now() < deadline) await delay(Math.min(5000, deadline - now()));
  }
  throw new Error(`Deployment readiness timed out: ${reason}`);
}
