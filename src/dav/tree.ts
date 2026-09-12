import type { TransferFile } from '../application/types.js';

export interface DavTransferSlug { id: string; name: string; slug: string }

function baseSlug(name: string): string {
  const cleaned = name.replace(/[\\/]/g, '_').trim();
  return cleaned || 'transfer';
}

// Stable, unique, human-readable root folder names: derived from each
// transfer's name, disambiguated with a short id suffix only when two
// transfers would otherwise collide (falling back to the full id in the
// pathological case where even that suffix collides).
export function transferSlugs(transfers: readonly { id: string; name: string }[]): DavTransferSlug[] {
  const bases = transfers.map(t => ({ ...t, base: baseSlug(t.name) }));
  const counts = new Map<string, number>();
  for (const t of bases) counts.set(t.base, (counts.get(t.base) ?? 0) + 1);
  const used = new Set<string>();
  return bases.map(t => {
    let slug = t.base;
    if ((counts.get(t.base) ?? 0) > 1 || used.has(slug)) slug = `${t.base}-${t.id.slice(0, 8)}`;
    if (used.has(slug)) slug = `${t.base}-${t.id}`;
    used.add(slug);
    return { id: t.id, name: t.name, slug };
  });
}

export interface DavChild {
  name: string;
  collection: boolean;
  // Present only when collection is false.
  bytes?: number;
  file?: TransferFile;
}

function pathParts(file: TransferFile): string[] {
  return file.path.split('/').filter(Boolean);
}

// A transfer's eligible files (already filtered to selected, complete video —
// see davRoutes) form a virtual directory tree by splitting each file's path
// on `/`. This answers "what's directly inside this folder" without ever
// materializing the whole tree.
function childrenAt(files: readonly TransferFile[], prefix: readonly string[]): DavChild[] {
  const children = new Map<string, DavChild>();
  for (const file of files) {
    const parts = pathParts(file);
    if (parts.length <= prefix.length || !prefix.every((segment, i) => parts[i] === segment)) continue;
    const name = parts[prefix.length]!;
    if (parts.length === prefix.length + 1) children.set(name, { name, collection: false, bytes: file.bytes, file });
    else if (!children.has(name)) children.set(name, { name, collection: true });
  }
  return [...children.values()];
}

function isKnownFolder(files: readonly TransferFile[], prefix: readonly string[]): boolean {
  return prefix.length === 0 || files.some(file => {
    const parts = pathParts(file);
    return parts.length > prefix.length && prefix.every((segment, i) => parts[i] === segment);
  });
}

function fileAt(files: readonly TransferFile[], segments: readonly string[]): TransferFile | undefined {
  if (!segments.length) return undefined;
  return files.find(file => {
    const parts = pathParts(file);
    return parts.length === segments.length && parts.every((segment, i) => segment === segments[i]);
  });
}

export type DavResource =
  | { kind: 'collection'; children: DavChild[] }
  | { kind: 'file'; file: TransferFile };

// Resolves the path segments after the transfer's own slug against its
// eligible-files list — an exact match is a file, a shared prefix is a
// folder, anything else does not exist.
export function resolveWithin(files: readonly TransferFile[], segments: readonly string[]): DavResource | undefined {
  const file = fileAt(files, segments);
  if (file) return { kind: 'file', file };
  if (isKnownFolder(files, segments)) return { kind: 'collection', children: childrenAt(files, segments) };
  return undefined;
}
