import { comparePermissionSets } from './comparison.js';

// ─── State ─────────────────────────────────────────────────────────────────────

let comparison = null;
let datasets = null;
let activeSection = 'summary';
let diffsOnly = true;
let filterText = '';

// All navigable sections in order (summary handled separately)
const SECTIONS = [
  { key: 'systemPermissions',       label: 'System Permissions' },
  { key: 'objectPermissions',       label: 'Object Permissions' },
  { key: 'fieldPermissions',        label: 'Field Permissions' },
  { key: 'tabSettings',             label: 'Tab Settings' },
  { key: 'apexClassAccess',         label: 'Apex Classes' },
  { key: 'vfPageAccess',            label: 'VF Pages' },
  { key: 'flowAccess',              label: 'Flows' },
  { key: 'appAccess',               label: 'Apps' },
  { key: 'customPermissions',       label: 'Custom Permissions' },
  { key: 'recordTypeAccess',        label: 'Record Types' },
  { key: 'namedCredentialAccess',   label: 'Named Credentials' },
  { key: 'externalDataSourceAccess',label: 'Ext. Data Sources' },
  { key: 'loginHours',              label: 'Login Hours' },
  { key: 'loginIpRanges',           label: 'Login IP Ranges' },
];

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const data = await chrome.storage.local.get('comparisonData');
    datasets = data.comparisonData;
    await chrome.storage.local.remove('comparisonData');
    if (!datasets || datasets.length < 2) {
      showError('No comparison data found. Please run a comparison from the extension popup.');
      return;
    }
    comparison = comparePermissionSets(datasets);
    renderSubtitle(datasets);
    renderTabBadges();
    renderSection();
  } catch (err) {
    showError(err.message);
  }
}

function renderSubtitle(ds) {
  document.getElementById('comparisonSubtitle').textContent =
    ds.map(d => {
      const kind = d.itemType === 'profile' ? 'Profile' : d.itemType === 'permissionsetgroup' ? 'PSG' : 'Perm Set';
      return `${d.orgName} › ${kind}: ${d.permissionSetLabel || d.permissionSetName}`;
    }).join('  vs  ');
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSection = btn.dataset.section;
    filterText = '';
    document.getElementById('filterInput').value = '';
    renderSection();
  });
});

document.getElementById('diffsOnlyToggle').addEventListener('change', e => {
  diffsOnly = e.target.checked;
  renderSection();
});

document.getElementById('filterInput').addEventListener('input', e => {
  filterText = e.target.value.toLowerCase();
  renderSection();
});

document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
document.getElementById('exportHtmlBtn').addEventListener('click', exportHTML);

function renderTabBadges() {
  if (!comparison) return;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const key = btn.dataset.section;
    if (key === 'summary') return;
    const rows = comparison[key] || [];
    const total = rows.length;
    const diffs = rows.filter(r => r.isDifferent).length;
    btn.querySelector('.badge')?.remove();
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = diffs > 0 ? `${diffs}/${total}` : total;
    btn.appendChild(badge);
    btn.classList.toggle('has-diffs', diffs > 0);
  });
}

// ─── Section Dispatcher ────────────────────────────────────────────────────────

function renderSection() {
  const content = document.getElementById('content');
  if (!comparison) return;

  // Hide filter bar for certain sections
  const noFilter = ['summary', 'loginHours', 'loginIpRanges'].includes(activeSection);
  document.querySelector('.filter-bar').style.display = noFilter ? 'none' : 'flex';

  switch (activeSection) {
    case 'summary':                 content.innerHTML = renderSummary(); break;
    case 'systemPermissions':       content.innerHTML = renderSystemPermissions(comparison.systemPermissions, comparison.headers); break;
    case 'objectPermissions':       content.innerHTML = renderObjectPermissions(comparison.objectPermissions, comparison.headers); break;
    case 'fieldPermissions':        content.innerHTML = renderFieldPermissions(comparison.fieldPermissions, comparison.headers); break;
    case 'tabSettings':             content.innerHTML = renderTabSettings(comparison.tabSettings, comparison.headers); break;
    case 'loginHours':              content.innerHTML = renderLoginHours(comparison.loginHours, comparison.headers); break;
    case 'loginIpRanges':           content.innerHTML = renderLoginIpRanges(comparison.loginIpRanges, comparison.headers); break;
    default:                        content.innerHTML = renderListSection(comparison[activeSection] || [], comparison.headers); break;
  }

  if (!noFilter) updateRowCount();
}

// ─── Shared Header Builder ─────────────────────────────────────────────────────

function makeHeaderCols(headers) {
  return headers.map(h => {
    const kind = h.itemType === 'profile' ? 'Profile' : h.itemType === 'permissionsetgroup' ? 'PSG' : 'Perm Set';
    return `<th>${escHtml(h.orgName)}<br><small>${kind}: ${escHtml(h.permissionSetLabel)}</small></th>`;
  }).join('');
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────

function renderSummary() {
  let totalDiffs = 0;

  const rows = SECTIONS.map(({ key, label }) => {
    const rows = comparison[key] || [];
    if (rows.length === 0) return null; // hide empty sections
    const diffs = rows.filter(r => r.isDifferent).length;
    totalDiffs += diffs;
    const pct = rows.length > 0 ? Math.round((diffs / rows.length) * 100) : 0;
    const status = diffs === 0
      ? `<span class="sum-ok">✓ Identical</span>`
      : `<span class="sum-diff">${diffs} difference${diffs !== 1 ? 's' : ''}</span>`;
    const bar = diffs > 0
      ? `<div class="diff-bar"><div class="diff-bar-fill" style="width:${pct}%"></div></div>`
      : '';
    return `
      <tr class="sum-row ${diffs > 0 ? 'sum-has-diff' : ''}" data-section="${key}">
        <td class="sum-label">${label}</td>
        <td class="sum-total">${rows.length}</td>
        <td class="sum-status">${status}${bar}</td>
      </tr>`;
  }).filter(Boolean).join('');

  const overallBadge = totalDiffs > 0
    ? `<span class="overall-diff">${totalDiffs} total differences found</span>`
    : `<span class="overall-ok">✓ No differences found</span>`;

  return `
    <div class="summary-wrap">
      <div class="summary-header">${overallBadge}</div>
      <div class="table-wrap">
        <table class="summary-table">
          <thead><tr><th>Category</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="sum-hint">Click any row to navigate to that section.</p>
    </div>`;
}

// Delegate clicks on summary rows
document.getElementById('content').addEventListener('click', e => {
  const row = e.target.closest('.sum-row[data-section]');
  if (!row) return;
  const section = row.dataset.section;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === section);
  });
  activeSection = section;
  document.querySelector('.filter-bar').style.display = 'flex';
  renderSection();
});

// ─── System Permissions ────────────────────────────────────────────────────────

function renderSystemPermissions(rows, headers) {
  const filtered = applyFilters(rows, r => r.name.toLowerCase());
  if (filtered.length === 0) return emptyMsg();
  const headerCols = makeHeaderCols(headers);
  const bodyRows = filtered.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v => {
      if (v === null) return `<td class="val-cell"><span class="perm-null">—</span></td>`;
      return `<td class="val-cell"><span class="${v ? 'perm-true' : 'perm-false'}">${v ? '✓' : '✗'}</span></td>`;
    }).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${escHtml(formatPermName(row.name))}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Permission</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

function formatPermName(raw) {
  return raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bApi\b/gi, 'API')
    .trim();
}

// ─── Object Permissions ────────────────────────────────────────────────────────

function renderObjectPermissions(rows, headers) {
  const filtered = applyFilters(rows, r => r.object.toLowerCase());
  if (filtered.length === 0) return emptyMsg();
  const headerCols = makeHeaderCols(headers);
  const bodyRows = filtered.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v =>
      v ? `<td class="val-cell">${crudChips(v)}</td>` : `<td class="val-cell"><span class="perm-null">—</span></td>`
    ).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${escHtml(row.object)}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Object</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

function crudChips(v) {
  const perms = [
    { key: 'read', label: 'R' }, { key: 'create', label: 'C' }, { key: 'edit', label: 'E' },
    { key: 'delete', label: 'D' }, { key: 'viewAll', label: 'VA' }, { key: 'modifyAll', label: 'MA' }
  ];
  return `<div class="crud-chips">${perms.map(p =>
    `<span class="chip ${v[p.key] ? 'chip-on' : 'chip-off'}">${p.label}</span>`
  ).join('')}</div>`;
}

// ─── Field Permissions ─────────────────────────────────────────────────────────

function renderFieldPermissions(rows, headers) {
  const filtered = applyFilters(rows, r => r.field.toLowerCase());
  if (filtered.length === 0) return emptyMsg();
  const headerCols = makeHeaderCols(headers);
  const bodyRows = filtered.map(row => {
    const [obj, field] = row.field.split('.');
    const label = `<span class="obj-label">${escHtml(obj)}</span>${escHtml(field || row.field)}`;
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v => {
      if (!v) return `<td class="val-cell"><span class="perm-null">—</span></td>`;
      return `<td class="val-cell"><div class="crud-chips">
        <span class="chip ${v.read ? 'chip-on' : 'chip-off'}">R</span>
        <span class="chip ${v.edit ? 'chip-on' : 'chip-off'}">E</span>
      </div></td>`;
    }).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${label}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Field</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

// ─── Tab Settings ──────────────────────────────────────────────────────────────

function renderTabSettings(rows, headers) {
  const filtered = applyFilters(rows, r => r.tab.toLowerCase());
  if (filtered.length === 0) return emptyMsg();
  const headerCols = makeHeaderCols(headers);
  const bodyRows = filtered.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v => {
      const cls = v === 'Visible' ? 'vis-visible' : v === 'Available' ? 'vis-available' : 'vis-none';
      return `<td class="val-cell"><span class="${cls}">${escHtml(v)}</span></td>`;
    }).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${escHtml(row.tab)}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Tab</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

// ─── Generic List Section ──────────────────────────────────────────────────────

function renderListSection(rows, headers) {
  const filtered = applyFilters(rows, r => r.name.toLowerCase());
  if (filtered.length === 0) return emptyMsg();
  const headerCols = makeHeaderCols(headers);
  const bodyRows = filtered.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v =>
      `<td class="val-cell"><span class="${v ? 'access-yes' : 'access-no'}">${v ? '✓' : '✗'}</span></td>`
    ).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${escHtml(row.name)}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Name</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

// ─── Login Hours ───────────────────────────────────────────────────────────────

function renderLoginHours(rows, headers) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-msg">Login hours are only available for profiles. No profile data in this comparison.</div>`;
  }
  const headerCols = makeHeaderCols(headers);
  const bodyRows = rows.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const vals = row.values.map(v => {
      if (v === null && row.values.every(x => x === null)) {
        return `<td class="val-cell"><span class="perm-null">N/A</span></td>`;
      }
      if (v === null) return `<td class="val-cell"><span class="vis-none">No access</span></td>`;
      return `<td class="val-cell"><span class="perm-true">${v.from} – ${v.to}</span></td>`;
    }).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${escHtml(row.day)}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">Day</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

// ─── Login IP Ranges ───────────────────────────────────────────────────────────

function renderLoginIpRanges(rows, headers) {
  if (!rows || rows.length === 0) {
    return `<div class="empty-msg">No login IP ranges configured, or no profiles in this comparison.</div>`;
  }
  const headerCols = makeHeaderCols(headers);
  const bodyRows = rows.map(row => {
    const dot = row.isDifferent ? '<span class="diff-dot"></span>' : '';
    const label = `${escHtml(row.startAddress)} – ${escHtml(row.endAddress)}`
      + (row.description ? `<br><span class="obj-label">${escHtml(row.description)}</span>` : '');
    const vals = row.values.map(v => {
      if (v === null) return `<td class="val-cell"><span class="perm-null">N/A</span></td>`;
      return `<td class="val-cell"><span class="${v ? 'access-yes' : 'access-no'}">${v ? '✓' : '✗'}</span></td>`;
    }).join('');
    return `<tr class="${row.isDifferent ? 'row-diff' : ''}"><td class="col-name">${dot}${label}</td>${vals}</tr>`;
  }).join('');
  return tableWrap(`<thead><tr><th class="col-name">IP Range</th>${headerCols}</tr></thead><tbody>${bodyRows}</tbody>`);
}

// ─── CSV Export ────────────────────────────────────────────────────────────────

function exportCSV() {
  if (!comparison || activeSection === 'summary') return;
  const rows = comparison[activeSection] || [];
  const headers = comparison.headers;
  const colHeaders = ['Name', ...headers.map(h => `${h.orgName} - ${h.permissionSetLabel}`)];
  const lines = [colHeaders.map(csvEsc).join(',')];
  for (const row of rows) {
    const name = row.name || row.object || row.field || row.tab || row.day ||
      (row.startAddress ? `${row.startAddress}-${row.endAddress}` : '');
    const vals = row.values.map(v => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'object' && v.from) return `${v.from}-${v.to}`;
      if (typeof v === 'object') return Object.entries(v).filter(([, val]) => val).map(([k]) => k).join('+');
      return String(v);
    });
    lines.push([name, ...vals].map(csvEsc).join(','));
  }
  downloadFile(lines.join('\n'), `perm-compare-${activeSection}-${Date.now()}.csv`, 'text/csv');
}

function csvEsc(val) {
  const s = String(val);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

// ─── HTML Export ──────────────────────────────────────────────────────────────

async function exportHTML() {
  if (!comparison) return;

  const subtitle = document.getElementById('comparisonSubtitle').textContent;

  const sectionBlocks = SECTIONS.map(({ key, label }) => {
    const rows = comparison[key] || [];
    if (rows.length === 0) return '';

    // Temporarily switch to this section to render its HTML
    const saved = { section: activeSection, diffs: diffsOnly, filter: filterText };
    activeSection = key; diffsOnly = false; filterText = '';
    renderSection();
    const html = document.getElementById('content').innerHTML;
    activeSection = saved.section; diffsOnly = saved.diffs; filterText = saved.filter;
    renderSection();

    const diffs = rows.filter(r => r.isDifferent).length;
    return `<section>
      <h2>${escHtml(label)} <span class="sec-badge ${diffs > 0 ? 'sec-badge-diff' : ''}">${diffs > 0 ? diffs + ' diff' : 'identical'}</span></h2>
      ${html}
    </section>`;
  }).join('');

  // Fetch the current stylesheet
  let css = '';
  try {
    const res = await fetch(chrome.runtime.getURL('results.css'));
    css = await res.text();
  } catch (_) {}

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Permission Set Comparison</title>
  <style>${css}
    body { max-width: 100%; }
    .page-header, .toolbar, .filter-bar { position: static; }
    section { margin-bottom: 40px; }
    h2 { font-size: 15px; font-weight: 700; color: #e6edf3; margin: 0 0 10px; display: flex; align-items: center; gap: 10px; }
    .sec-badge { font-size: 10px; background: #21262d; border-radius: 10px; padding: 2px 8px; color: #8b949e; }
    .sec-badge-diff { background: #6e1a00; color: #ffa657; }
  </style>
</head>
<body>
  <div class="page-header">
    <div class="page-title">
      <span class="logo">SF</span>
      <div>
        <h1>Permission Set Comparison</h1>
        <div class="subtitle">${escHtml(subtitle)}</div>
      </div>
    </div>
    <div style="font-size:11px;color:#6e7681;">Generated ${new Date().toLocaleString()}</div>
  </div>
  <div style="padding:20px">${sectionBlocks}</div>
</body>
</html>`;

  downloadFile(html, `perm-compare-${Date.now()}.html`, 'text/html');
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function applyFilters(rows, getKey) {
  return rows.filter(row => {
    if (diffsOnly && !row.isDifferent) return false;
    if (filterText && !getKey(row).includes(filterText)) return false;
    return true;
  });
}

function updateRowCount() {
  const rows = document.querySelectorAll('#content tbody tr');
  const diffRows = document.querySelectorAll('#content tbody tr.row-diff');
  const el = document.getElementById('rowCount');
  el.textContent = rows.length === 0 ? '' :
    `${rows.length} rows${diffRows.length > 0 ? ` · ${diffRows.length} differences` : ''}`;
}

function tableWrap(inner) {
  return `<div class="table-wrap"><table>${inner}</table></div>`;
}

function emptyMsg() {
  return `<div class="empty-msg">${diffsOnly ? 'No differences found in this category.' : 'No data in this category.'}</div>`;
}

function showError(msg) {
  document.getElementById('content').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

init();
