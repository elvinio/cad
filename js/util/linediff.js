// Tiny line-level diff for the apply-confirm dialog. No dependencies — keeps the
// no-build promise. Computes an LCS over lines and emits a sequence of rows:
//   { type: 'context' | 'add' | 'del', text }
// Display-only; not meant for large files (chat code is a single SCAD file).

export function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length, m = b.length;

  // LCS length table (n+1 × m+1). Fine for SCAD-sized files.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] });
  while (j < m) rows.push({ type: 'add', text: b[j++] });
  return rows;
}
