const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });

// ─── State ─────────────────────────────────────────────────────────────────────

let orgs = [];
let permissionSets = {}; // { orgId: [{Id, Label, Name}] }
let selectedPS = {};     // { orgId: permissionSetId }

// ─── Init ──────────────────────────────────────────────────────────────────────

document.getElementById('scanBtn').addEventListener('click', scanTabs);
document.getElementById('compareBtn').addEventListener('click', runComparison);

document.getElementById('manualToggle').addEventListener('click', () => {
  const input = document.getElementById('manualInput');
  input.style.display = input.style.display === 'none' ? 'flex' : 'none';
  if (input.style.display === 'flex') document.getElementById('orgUrlInput').focus();
});

document.getElementById('addByUrlBtn').addEventListener('click', () => {
  const url = document.getElementById('orgUrlInput').value.trim();
  if (url) addOrgByUrl(url);
});

document.getElementById('orgUrlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = document.getElementById('orgUrlInput').value.trim();
    if (url) addOrgByUrl(url);
  }
});

init();

async function init() {
  try {
    orgs = await send('GET_ORGS');
    renderOrgs();
    if (orgs.length >= 2) await loadAllPermissionSets();
  } catch (err) {
    showStatus(err.message, 'error');
  }
}

// ─── Org Rendering ─────────────────────────────────────────────────────────────

function renderOrgs() {
  const list = document.getElementById('orgsList');
  if (orgs.length === 0) {
    list.innerHTML = '<div class="no-orgs">No orgs added yet. Scan your open tabs below.</div>';
  } else {
    list.innerHTML = orgs.map(org => `
      <div class="org-item">
        <div class="org-info">
          <div class="org-name">${escHtml(org.name)}</div>
          <div class="org-url">${escHtml(org.instanceUrl)}</div>
        </div>
        <button class="disconnect-btn" data-orgid="${escHtml(org.id)}">Remove</button>
      </div>`).join('');

    list.querySelectorAll('.disconnect-btn').forEach(btn =>
      btn.addEventListener('click', () => disconnectOrg(btn.dataset.orgid))
    );
  }

  document.getElementById('psSection').style.display = orgs.length >= 2 ? 'block' : 'none';
}

async function disconnectOrg(orgId) {
  await send('DISCONNECT_ORG', { orgId });
  orgs = orgs.filter(o => o.id !== orgId);
  delete permissionSets[orgId];
  delete selectedPS[orgId];
  renderOrgs();
  renderPSSelectors();
}

// ─── Tab Scanning ──────────────────────────────────────────────────────────────

async function scanTabs() {
  const btn = document.getElementById('scanBtn');
  const icon = btn.querySelector('.scan-icon');
  btn.disabled = true;
  icon.classList.add('spinning');
  hideStatus();

  // Remove any previous scan results
  document.querySelectorAll('.scan-results-container').forEach(el => el.remove());

  try {
    const found = await send('SCAN_TABS');

    icon.classList.remove('spinning');
    btn.disabled = false;

    if (found.length === 0) {
      showStatus(
        'No active Salesforce sessions found. Make sure you\'re logged in to your orgs in Chrome.',
        'info'
      );
      return;
    }

    // Show found orgs as "add" cards
    const container = document.createElement('div');
    container.className = 'scan-results-container';

    for (const foundOrg of found) {
      const alreadyAdded = orgs.some(o => o.id === foundOrg.id);
      const card = document.createElement('div');
      card.className = 'scan-result';
      card.innerHTML = `
        <div class="scan-result-info">
          <div class="scan-result-name">${escHtml(foundOrg.name)}</div>
          <div class="scan-result-url">${escHtml(new URL(foundOrg.instanceUrl).hostname)}</div>
        </div>
        <button class="btn-add-small" ${alreadyAdded ? 'disabled' : ''}>
          ${alreadyAdded ? '✓ Added' : 'Add'}
        </button>`;

      if (!alreadyAdded) {
        card.querySelector('button').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          e.currentTarget.textContent = 'Adding…';
          await addFoundOrg(foundOrg);
          e.currentTarget.textContent = '✓ Added';
        });
      }

      container.appendChild(card);
    }

    // Insert below scan button
    document.getElementById('scanBtn').insertAdjacentElement('afterend', container);
  } catch (err) {
    icon.classList.remove('spinning');
    btn.disabled = false;
    showStatus(err.message, 'error');
  }
}

async function addFoundOrg(foundOrg) {
  try {
    // The background already has the org from the scan; we just need to save it
    const result = await send('CONNECT_ORG_BY_URL', { instanceUrl: foundOrg.instanceUrl });
    if (!orgs.find(o => o.id === result.org.id)) orgs.push(result.org);
    else orgs = orgs.map(o => o.id === result.org.id ? result.org : o);
    renderOrgs();
    if (orgs.length >= 2) await loadAllPermissionSets();
  } catch (err) {
    showStatus(err.message, 'error');
  }
}

async function addOrgByUrl(url) {
  showStatus('Connecting…', 'info');
  try {
    const result = await send('CONNECT_ORG_BY_URL', { instanceUrl: url });
    if (!orgs.find(o => o.id === result.org.id)) orgs.push(result.org);
    else orgs = orgs.map(o => o.id === result.org.id ? result.org : o);
    document.getElementById('orgUrlInput').value = '';
    document.getElementById('manualInput').style.display = 'none';
    hideStatus();
    renderOrgs();
    if (orgs.length >= 2) await loadAllPermissionSets();
  } catch (err) {
    showStatus(err.message, 'error');
  }
}

// ─── Permission Sets ───────────────────────────────────────────────────────────

async function loadAllPermissionSets() {
  renderPSSelectors(true);
  await Promise.all(orgs.map(async org => {
    try {
      permissionSets[org.id] = await send('GET_PERMISSION_SETS', { orgId: org.id });
    } catch (err) {
      permissionSets[org.id] = { profiles: [], permissionSets: [] };
      console.warn(`PS load failed for ${org.name}:`, err.message);
    }
  }));
  renderPSSelectors();
}

function renderPSSelectors(loading = false) {
  const container = document.getElementById('psSelectors');
  const btn = document.getElementById('compareBtn');

  if (orgs.length < 2) {
    container.innerHTML = '';
    btn.disabled = true;
    return;
  }

  if (loading) {
    container.innerHTML = '<div class="hint">Loading profiles and permission sets…</div>';
    btn.disabled = true;
    return;
  }

  container.innerHTML = orgs.map(org => {
    const data = permissionSets[org.id] || { profiles: [], permissionSets: [], permissionSetGroups: [] };
    const isEmpty = !data.profiles.length && !data.permissionSets.length && !data.permissionSetGroups.length;

    const profileOpts = data.profiles.map(p =>
      `<option value="profile:${p.id}">${escHtml(p.label)}</option>`
    ).join('');

    const psOpts = data.permissionSets.map(ps =>
      `<option value="permissionset:${ps.id}">${escHtml(ps.label)}</option>`
    ).join('');

    const psgOpts = (data.permissionSetGroups || []).map(g =>
      `<option value="permissionsetgroup:${g.id}">${escHtml(g.label)}</option>`
    ).join('');

    const groups = [
      data.profiles.length             ? `<optgroup label="Profiles">${profileOpts}</optgroup>` : '',
      data.permissionSets.length       ? `<optgroup label="Permission Sets">${psOpts}</optgroup>` : '',
      data.permissionSetGroups?.length ? `<optgroup label="Permission Set Groups">${psgOpts}</optgroup>` : ''
    ].join('');

    return `
      <div class="ps-selector">
        <label>${escHtml(org.name)}</label>
        <select data-orgid="${escHtml(org.id)}" ${isEmpty ? 'disabled' : ''}>
          <option value="">— Select profile, permission set, or group —</option>
          ${groups}
        </select>
      </div>`;
  }).join('');

  container.querySelectorAll('select').forEach(sel => {
    if (selectedPS[sel.dataset.orgid]) sel.value = selectedPS[sel.dataset.orgid];
    sel.addEventListener('change', () => {
      selectedPS[sel.dataset.orgid] = sel.value;
      updateCompareBtn();
    });
  });

  updateCompareBtn();
}

function updateCompareBtn() {
  const ready = orgs.length >= 2 && orgs.every(o => !!selectedPS[o.id]);
  document.getElementById('compareBtn').disabled = !ready;
}

// ─── Comparison ────────────────────────────────────────────────────────────────

async function runComparison() {
  showStatus('Fetching permission data…', 'info');
  document.getElementById('compareBtn').disabled = true;

  try {
    const datasets = await Promise.all(
      orgs.map(org => {
        const [itemType, id] = selectedPS[org.id].split(':');
        return send('FETCH_PERMISSION_SET_DATA', { orgId: org.id, id, itemType });
      })
    );
    await chrome.storage.local.set({ comparisonData: datasets });
    await chrome.tabs.create({ url: chrome.runtime.getURL('results.html') });
    hideStatus();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    document.getElementById('compareBtn').disabled = false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function showStatus(msg, type) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.style.display = 'block';
}

function hideStatus() {
  document.getElementById('statusMsg').style.display = 'none';
}

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
