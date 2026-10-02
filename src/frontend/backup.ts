export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const PART_TARGET_BYTES = 6 * 1024 * 1024;
const MAX_LINKS_PER_PART = 1000;

interface Backup {
  version: number;
  categories: unknown[];
  links: unknown[];
}
export interface BackupPart {
  contents: string;
  linkCount: number;
  bytes: number;
}

/** Every part is a complete merge document; categories repeat so parts stand alone. */
export function createBackupParts(backup: Backup): BackupPart[] {
  if (backup.version !== 1 || !Array.isArray(backup.categories) || !Array.isArray(backup.links)) {
    throw new Error('导出内容格式不正确，请刷新后重试。');
  }
  if (backup.categories.length > 100) {
    throw new Error('当前分类超过单份备份的 100 个上限，请先整理分类。');
  }
  const encoder = new TextEncoder();
  const single = JSON.stringify({ ...backup, mode: 'merge' }, null, 2) + '\n';
  const singleBytes = encoder.encode(single).byteLength;
  if (singleBytes <= MAX_IMPORT_BYTES && backup.links.length <= MAX_LINKS_PER_PART) {
    return [{ contents: single, linkCount: backup.links.length, bytes: singleBytes }];
  }
  const prefix =
    JSON.stringify({ version: 1, mode: 'merge', categories: backup.categories }).slice(0, -1) +
    ',"links":[';
  const suffix = ']}\n';
  const envelopeBytes = encoder.encode(prefix + suffix).byteLength;
  const parts: BackupPart[] = [];
  let serialized: string[] = [];
  let bytes = envelopeBytes;
  function flush(): void {
    parts.push({
      contents: prefix + serialized.join(',') + suffix,
      linkCount: serialized.length,
      bytes,
    });
    serialized = [];
    bytes = envelopeBytes;
  }
  for (const link of backup.links) {
    const record = JSON.stringify(link);
    const recordBytes = encoder.encode(record).byteLength;
    if (envelopeBytes + recordBytes > MAX_IMPORT_BYTES)
      throw new Error('单个资源超过可导入大小，请缩短该资源的备注或简介后重试。');
    if (
      serialized.length &&
      (serialized.length === MAX_LINKS_PER_PART || bytes + recordBytes + 1 > PART_TARGET_BYTES)
    )
      flush();
    bytes += recordBytes + (serialized.length ? 1 : 0);
    serialized.push(record);
  }
  if (serialized.length || !parts.length) flush();
  return parts;
}
