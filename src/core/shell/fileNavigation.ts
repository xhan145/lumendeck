export interface FileBreadcrumb {
  label: string;
  path: string;
}

/** Break only an already-selected absolute path into real, navigable ancestors. */
export function fileBreadcrumbs(input: string): FileBreadcrumb[] {
  if (!input || typeof input !== 'string') return [];
  const windows = /^[a-zA-Z]:[\\/]/.test(input);
  const unc = input.startsWith('\\\\');
  if (windows) {
    const clean = input.replace(/\//g, '\\');
    const root = clean.slice(0, 3);
    const nodes: FileBreadcrumb[] = [{ label: root.slice(0, 2), path: root }];
    let path = root;
    for (const part of clean.slice(3).split('\\').filter(Boolean)) {
      path = path.endsWith('\\') ? path + part : path + '\\' + part;
      nodes.push({ label: part, path });
    }
    return nodes;
  }
  if (unc) {
    const parts = input.replace(/\//g, '\\').slice(2).split('\\').filter(Boolean);
    if (parts.length < 2) return [];
    let path = '\\\\' + parts[0] + '\\' + parts[1] + '\\';
    const nodes: FileBreadcrumb[] = [{ label: parts[0] + '/' + parts[1], path }];
    for (const part of parts.slice(2)) {
      path += (path.endsWith('\\') ? '' : '\\') + part;
      nodes.push({ label: part, path });
    }
    return nodes;
  }
  if (input.startsWith('/')) {
    const nodes: FileBreadcrumb[] = [{ label: '/', path: '/' }];
    let path = '';
    for (const part of input.split('/').filter(Boolean)) {
      path += '/' + part;
      nodes.push({ label: part, path });
    }
    return nodes;
  }
  return [];
}
