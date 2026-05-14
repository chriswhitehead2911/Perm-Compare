import { SalesforceAPI } from './sf-api.js';

// ─── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'GET_ORGS':                  return getOrgs();
    case 'SCAN_TABS':                 return scanOpenTabs();
    case 'CONNECT_ORG_BY_URL':        return connectOrgByUrl(msg.instanceUrl);
    case 'DISCONNECT_ORG':            return disconnectOrg(msg.orgId);
    case 'GET_PERMISSION_SETS':       return getPermissionSets(msg.orgId);
    case 'FETCH_PERMISSION_SET_DATA': return fetchPermissionSetData(msg.orgId, msg.id, msg.itemType);
    default:                          throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ─── Org Storage (no tokens stored) ───────────────────────────────────────────

async function getOrgs() {
  const data = await chrome.storage.local.get('orgs');
  return data.orgs || [];
}

async function saveOrgs(orgs) {
  await chrome.storage.local.set({ orgs });
}

// ─── Session Cookie ────────────────────────────────────────────────────────────

/**
 * Reads the Salesforce `sid` session cookie for a given instance URL.
 * Throws a clear error if the user isn't logged in.
 */
async function getSession(instanceUrl) {
  const cookie = await chrome.cookies.get({ url: instanceUrl, name: 'sid' });
  if (!cookie?.value) {
    const host = new URL(instanceUrl).hostname;
    throw new Error(
      `No active session found for ${host}. Please reload that Salesforce tab and log in, then try again.`
    );
  }
  return cookie.value;
}

// ─── Tab Scanner ───────────────────────────────────────────────────────────────

/**
 * Scans all open Chrome tabs for Salesforce orgs, reads their session cookies,
 * and returns an array of { id, name, instanceUrl } for orgs that are active.
 */
async function scanOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const checkedUrls = new Set();
  const found = [];

  for (const tab of tabs) {
    if (!tab.url) continue;
    let url;
    try { url = new URL(tab.url); } catch (_) { continue; }

    const instanceUrl = normalizeToInstanceUrl(url);
    if (!instanceUrl || checkedUrls.has(instanceUrl)) continue;
    checkedUrls.add(instanceUrl);

    // Try to read the session cookie
    let sessionId;
    try { sessionId = await getSession(instanceUrl); } catch (_) { continue; }

    // Verify the session by fetching the org name
    try {
      const api = new SalesforceAPI(instanceUrl, sessionId);
      const result = await api.query('SELECT Id, Name FROM Organization LIMIT 1');
      const org = result.records[0];
      found.push({ id: org.Id, name: org.Name, instanceUrl });
    } catch (_) {
      // Session exists but API call failed — skip
    }
  }

  return found;
}

// ─── Connect Org ───────────────────────────────────────────────────────────────

async function connectOrgByUrl(rawUrl) {
  const instanceUrl = normalizeToInstanceUrl(new URL(
    rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
  ));

  if (!instanceUrl) {
    throw new Error('Could not recognize this as a Salesforce URL. Expected *.salesforce.com or *.force.com');
  }

  const sessionId = await getSession(instanceUrl);
  const api = new SalesforceAPI(instanceUrl, sessionId);
  const result = await api.query('SELECT Id, Name FROM Organization LIMIT 1');
  const org = result.records[0];

  return addOrSaveOrg({ id: org.Id, name: org.Name, instanceUrl });
}

async function addOrSaveOrg(orgEntry) {
  const orgs = await getOrgs();
  const idx = orgs.findIndex(o => o.id === orgEntry.id);
  const entry = { ...orgEntry, connectedAt: new Date().toISOString() };
  if (idx >= 0) orgs[idx] = entry; else orgs.push(entry);
  await saveOrgs(orgs);
  return { success: true, org: entry };
}

async function disconnectOrg(orgId) {
  const orgs = await getOrgs();
  await saveOrgs(orgs.filter(o => o.id !== orgId));
  return { success: true };
}

// ─── Permission Sets ───────────────────────────────────────────────────────────

async function getOrgAndSession(orgId) {
  const orgs = await getOrgs();
  const org = orgs.find(o => o.id === orgId);
  if (!org) throw new Error('Org not found. Try re-adding it.');
  const sessionId = await getSession(org.instanceUrl);
  return { org, api: new SalesforceAPI(org.instanceUrl, sessionId) };
}

async function getPermissionSets(orgId) {
  const { api } = await getOrgAndSession(orgId);

  const [psResult, profileResult, psgResult] = await Promise.all([
    api.query(
      'SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND PermissionSetGroupId = null ORDER BY Label ASC'
    ),
    api.query('SELECT Id, Name FROM Profile ORDER BY Name ASC'),
    api.query('SELECT Id, MasterLabel, DeveloperName, MutingPermissionSetId FROM PermissionSetGroup ORDER BY MasterLabel ASC')
      .catch(() => ({ records: [] })) // PSGs may not exist or may not be enabled in all orgs
  ]);

  return {
    permissionSets: psResult.records.map(ps => ({
      id: ps.Id,
      label: ps.Label || ps.Name,
      type: 'permissionset'
    })),
    profiles: profileResult.records.map(p => ({
      id: p.Id,
      label: p.Name,
      type: 'profile'
    })),
    permissionSetGroups: psgResult.records.map(g => ({
      id: g.Id,
      label: g.MasterLabel || g.DeveloperName,
      mutingPermissionSetId: g.MutingPermissionSetId || null,
      type: 'permissionsetgroup'
    }))
  };
}

async function fetchPermissionSetData(orgId, id, itemType = 'permissionset') {
  const { org, api } = await getOrgAndSession(orgId);

  if (itemType === 'permissionsetgroup') {
    return fetchPermissionSetGroupData(org, api, id);
  }

  let permissionSetId, displayName, displayLabel, profileId = null;

  if (itemType === 'profile') {
    profileId = id;
    const [profileInfo, psInfo] = await Promise.all([
      api.query(`SELECT Id, Name FROM Profile WHERE Id = '${id}'`),
      api.query(`SELECT Id FROM PermissionSet WHERE ProfileId = '${id}' AND IsOwnedByProfile = true LIMIT 1`)
    ]);
    if (!profileInfo.records[0]) throw new Error('Profile not found.');
    if (!psInfo.records[0]) throw new Error('Could not find the PermissionSet linked to this profile.');
    displayName = profileInfo.records[0].Name;
    displayLabel = profileInfo.records[0].Name;
    permissionSetId = psInfo.records[0].Id;
  } else {
    const psInfo = await api.query(`SELECT Id, Name, Label FROM PermissionSet WHERE Id = '${id}'`);
    if (!psInfo.records[0]) throw new Error('Permission Set not found.');
    displayName = psInfo.records[0].Name;
    displayLabel = psInfo.records[0].Label;
    permissionSetId = id;
  }

  const [systemPerms, objectPerms, fieldPerms, tabSettings, setupAccess] =
    await Promise.all([
      fetchSystemPermissions(api, permissionSetId),
      fetchObjectPermissions(api, permissionSetId),
      fetchFieldPermissions(api, permissionSetId),
      fetchTabSettings(api, permissionSetId),
      fetchSetupEntityAccess(api, permissionSetId)
    ]);

  // Profile-only: login hours and IP ranges
  let loginHours = null, loginIpRanges = [];
  if (itemType === 'profile' && profileId) {
    [loginHours, loginIpRanges] = await Promise.all([
      fetchLoginHours(api, profileId),
      fetchLoginIpRanges(api, profileId)
    ]);
  }

  return {
    orgId,
    orgName: org.name,
    orgInstanceUrl: org.instanceUrl,
    itemType,
    profileId,
    permissionSetId,
    permissionSetName: displayName,
    permissionSetLabel: displayLabel,
    systemPermissions: systemPerms,
    objectPermissions: objectPerms,
    fieldPermissions: fieldPerms,
    tabSettings,
    apexClassAccess: setupAccess.apexClasses,
    vfPageAccess: setupAccess.vfPages,
    customPermissions: setupAccess.customPermissions,
    recordTypeAccess: setupAccess.recordTypes,
    flowAccess: setupAccess.flows,
    appAccess: setupAccess.apps,
    namedCredentialAccess: setupAccess.namedCredentials,
    externalDataSourceAccess: setupAccess.externalDataSources,
    loginHours,
    loginIpRanges
  };
}

// ─── Permission Set Group (effective permissions) ──────────────────────────────

async function fetchPermissionSetGroupData(org, api, psgId) {
  // Resolve group label and muting PS
  const psgInfo = await api.query(
    `SELECT Id, MasterLabel, DeveloperName, MutingPermissionSetId FROM PermissionSetGroup WHERE Id = '${psgId}'`
  );
  if (!psgInfo.records[0]) throw new Error('Permission Set Group not found.');
  const psg = psgInfo.records[0];
  const displayLabel = psg.MasterLabel || psg.DeveloperName;

  // Get member permission set IDs
  const componentResult = await api.queryAll(
    `SELECT PermissionSetId FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = '${psgId}'`
  );
  const memberIds = componentResult.records.map(r => r.PermissionSetId);

  if (memberIds.length === 0) {
    // Empty group — return zeroed-out structure
    return {
      orgId: org.id, orgName: org.name, orgInstanceUrl: org.instanceUrl,
      itemType: 'permissionsetgroup', profileId: null,
      permissionSetId: psgId, permissionSetName: psg.DeveloperName, permissionSetLabel: displayLabel,
      systemPermissions: {}, objectPermissions: {}, fieldPermissions: {},
      tabSettings: {}, apexClassAccess: [], vfPageAccess: [], customPermissions: [],
      recordTypeAccess: [], flowAccess: [], appAccess: [], namedCredentialAccess: [],
      externalDataSourceAccess: [], loginHours: null, loginIpRanges: []
    };
  }

  // Fetch permissions for each member PS in parallel
  const memberDatasets = await Promise.all(
    memberIds.map(async psId => {
      const [systemPerms, objectPerms, fieldPerms, tabSettings, setupAccess] = await Promise.all([
        fetchSystemPermissions(api, psId),
        fetchObjectPermissions(api, psId),
        fetchFieldPermissions(api, psId),
        fetchTabSettings(api, psId),
        fetchSetupEntityAccess(api, psId)
      ]);
      return { systemPerms, objectPerms, fieldPerms, tabSettings, setupAccess };
    })
  );

  // Union all member datasets
  const unified = unionMemberDatasets(memberDatasets);

  // Subtract muting permission set if present
  if (psg.MutingPermissionSetId) {
    const [mutingSystem, mutingObject] = await Promise.all([
      fetchSystemPermissions(api, psg.MutingPermissionSetId),
      fetchObjectPermissions(api, psg.MutingPermissionSetId)
    ]);
    applyMutingPermissions(unified, mutingSystem, mutingObject);
  }

  return {
    orgId: org.id, orgName: org.name, orgInstanceUrl: org.instanceUrl,
    itemType: 'permissionsetgroup', profileId: null,
    permissionSetId: psgId, permissionSetName: psg.DeveloperName, permissionSetLabel: displayLabel,
    systemPermissions: unified.systemPerms,
    objectPermissions: unified.objectPerms,
    fieldPermissions: unified.fieldPerms,
    tabSettings: unified.tabSettings,
    apexClassAccess: unified.setupAccess.apexClasses,
    vfPageAccess: unified.setupAccess.vfPages,
    customPermissions: unified.setupAccess.customPermissions,
    recordTypeAccess: unified.setupAccess.recordTypes,
    flowAccess: unified.setupAccess.flows,
    appAccess: unified.setupAccess.apps,
    namedCredentialAccess: unified.setupAccess.namedCredentials,
    externalDataSourceAccess: unified.setupAccess.externalDataSources,
    loginHours: null, loginIpRanges: []
  };
}

function unionMemberDatasets(members) {
  const systemPerms = {};
  const objectPerms = {};
  const fieldPerms = {};
  const tabSettings = {};
  const TAB_RANK = { 'Visible': 2, 'Available': 1, 'None': 0 };
  const setupAccess = {
    apexClasses: new Set(), vfPages: new Set(), customPermissions: new Set(),
    recordTypes: new Set(), flows: new Set(), apps: new Set(),
    namedCredentials: new Set(), externalDataSources: new Set()
  };

  for (const { systemPerms: sp, objectPerms: op, fieldPerms: fp, tabSettings: ts, setupAccess: sa } of members) {
    // System permissions: OR (true wins)
    for (const [k, v] of Object.entries(sp)) {
      systemPerms[k] = systemPerms[k] || v;
    }
    // Object permissions: per CRUD flag, OR across members
    for (const [obj, v] of Object.entries(op)) {
      if (!objectPerms[obj]) {
        objectPerms[obj] = { ...v };
      } else {
        for (const flag of ['create', 'read', 'edit', 'delete', 'viewAll', 'modifyAll']) {
          objectPerms[obj][flag] = objectPerms[obj][flag] || v[flag];
        }
      }
    }
    // Field permissions: OR read/edit flags
    for (const [field, v] of Object.entries(fp)) {
      if (!fieldPerms[field]) {
        fieldPerms[field] = { ...v };
      } else {
        fieldPerms[field].read = fieldPerms[field].read || v.read;
        fieldPerms[field].edit = fieldPerms[field].edit || v.edit;
      }
    }
    // Tab settings: highest visibility wins
    for (const [tab, vis] of Object.entries(ts)) {
      const current = TAB_RANK[tabSettings[tab]] ?? -1;
      if ((TAB_RANK[vis] ?? 0) > current) tabSettings[tab] = vis;
    }
    // List-based access: union sets
    for (const cls of sa.apexClasses)          setupAccess.apexClasses.add(cls);
    for (const pg of sa.vfPages)               setupAccess.vfPages.add(pg);
    for (const cp of sa.customPermissions)     setupAccess.customPermissions.add(cp);
    for (const rt of sa.recordTypes)           setupAccess.recordTypes.add(rt);
    for (const fl of sa.flows)                 setupAccess.flows.add(fl);
    for (const ap of sa.apps)                  setupAccess.apps.add(ap);
    for (const nc of sa.namedCredentials)      setupAccess.namedCredentials.add(nc);
    for (const ds of sa.externalDataSources)   setupAccess.externalDataSources.add(ds);
  }

  return {
    systemPerms,
    objectPerms,
    fieldPerms,
    tabSettings,
    setupAccess: {
      apexClasses:          [...setupAccess.apexClasses].sort(),
      vfPages:              [...setupAccess.vfPages].sort(),
      customPermissions:    [...setupAccess.customPermissions].sort(),
      recordTypes:          [...setupAccess.recordTypes].sort(),
      flows:                [...setupAccess.flows].sort(),
      apps:                 [...setupAccess.apps].sort(),
      namedCredentials:     [...setupAccess.namedCredentials].sort(),
      externalDataSources:  [...setupAccess.externalDataSources].sort()
    }
  };
}

function applyMutingPermissions(unified, mutingSystem, mutingObject) {
  for (const [k, v] of Object.entries(mutingSystem)) {
    if (v && k in unified.systemPerms) unified.systemPerms[k] = false;
  }
  for (const [obj, v] of Object.entries(mutingObject)) {
    if (unified.objectPerms[obj]) {
      for (const flag of ['create', 'read', 'edit', 'delete', 'viewAll', 'modifyAll']) {
        if (v[flag]) unified.objectPerms[obj][flag] = false;
      }
    }
  }
}

// ─── System Permissions ────────────────────────────────────────────────────────

async function fetchSystemPermissions(api, permissionSetId) {
  let permFields = FALLBACK_SYSTEM_PERMISSIONS;
  try {
    const desc = await api.describe('PermissionSet');
    const dynamic = desc.fields
      .filter(f => f.name.startsWith('Permissions') && f.type === 'boolean')
      .map(f => f.name);
    if (dynamic.length > 0) permFields = dynamic;
  } catch (_) {}

  const perms = {};
  for (const chunk of chunkArray(permFields, 150)) {
    const result = await api.query(
      `SELECT ${chunk.join(', ')} FROM PermissionSet WHERE Id = '${permissionSetId}'`
    );
    if (result.records.length > 0) {
      const rec = result.records[0];
      for (const field of chunk) {
        if (rec[field] === true || rec[field] === false) {
          perms[field.replace(/^Permissions/, '')] = rec[field];
        }
      }
    }
  }
  return perms;
}

// ─── Object Permissions ────────────────────────────────────────────────────────

async function fetchObjectPermissions(api, permissionSetId) {
  const result = await api.queryAll(
    'SELECT SobjectType, PermissionsCreate, PermissionsRead, PermissionsEdit, ' +
    'PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords ' +
    `FROM ObjectPermissions WHERE ParentId = '${permissionSetId}'`
  );
  const perms = {};
  for (const rec of result.records) {
    perms[rec.SobjectType] = {
      create: rec.PermissionsCreate,
      read: rec.PermissionsRead,
      edit: rec.PermissionsEdit,
      delete: rec.PermissionsDelete,
      viewAll: rec.PermissionsViewAllRecords,
      modifyAll: rec.PermissionsModifyAllRecords
    };
  }
  return perms;
}

// ─── Field Permissions ─────────────────────────────────────────────────────────

async function fetchFieldPermissions(api, permissionSetId) {
  const result = await api.queryAll(
    'SELECT SobjectType, Field, PermissionsEdit, PermissionsRead ' +
    `FROM FieldPermissions WHERE ParentId = '${permissionSetId}'`
  );
  const perms = {};
  for (const rec of result.records) {
    perms[rec.Field] = { read: rec.PermissionsRead, edit: rec.PermissionsEdit };
  }
  return perms;
}

// ─── Tab Settings ──────────────────────────────────────────────────────────────

async function fetchTabSettings(api, permissionSetId) {
  const result = await api.queryAll(
    `SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = '${permissionSetId}'`
  );
  const settings = {};
  for (const rec of result.records) settings[rec.Name] = rec.Visibility;
  return settings;
}

// ─── Setup Entity Access ───────────────────────────────────────────────────────

async function fetchSetupEntityAccess(api, permissionSetId) {
  const result = await api.queryAll(
    'SELECT SetupEntityId, SetupEntityType ' +
    `FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}'`
  );

  const byType = {};
  for (const rec of result.records) {
    (byType[rec.SetupEntityType] ??= []).push(rec.SetupEntityId);
  }

  // Apps can appear as TabSet (classic) or AppMenuItem (Lightning) depending on the org
  const appIds = [...(byType.TabSet || []), ...(byType.AppMenuItem || [])];

  const [apexClasses, vfPages, customPermissions, recordTypes, flows, apps, namedCredentials, externalDataSources] =
    await Promise.all([
      resolveNames(api, 'ApexClass', byType.ApexClass || []),
      resolveNames(api, 'ApexPage', byType.ApexPage || []),
      resolveCustomPermissions(api, byType.CustomPermission || []),
      resolveRecordTypes(api, byType.RecordType || []),
      resolveFlows(api, byType.Flow || []),
      resolveApps(api, appIds),
      resolveNamedCredentials(api, byType.NamedCredential || []),
      resolveExternalDataSources(api, byType.ExternalDataSource || [])
    ]);

  return { apexClasses, vfPages, customPermissions, recordTypes, flows, apps, namedCredentials, externalDataSources };
}

async function resolveNames(api, sobject, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT Name FROM ${sobject} WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.Name));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveCustomPermissions(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT DeveloperName FROM CustomPermission WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.DeveloperName));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveRecordTypes(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT SobjectType, DeveloperName FROM RecordType WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => `${rec.SobjectType}.${rec.DeveloperName}`));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveFlows(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      // FlowDefinition is a Tooling API object — fall back to IDs if unavailable
      const r = await api.toolingQuery(`SELECT Id, MasterLabel FROM FlowDefinition WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.MasterLabel));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveApps(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT Id, Label FROM AppMenuItem WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.Label));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveNamedCredentials(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT Id, MasterLabel FROM NamedCredential WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.MasterLabel));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

async function resolveExternalDataSources(api, ids) {
  if (!ids.length) return [];
  const names = [];
  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map(id => `'${id}'`).join(',');
    try {
      const r = await api.queryAll(`SELECT Id, MasterLabel FROM ExternalDataSource WHERE Id IN (${idList})`);
      names.push(...r.records.map(rec => rec.MasterLabel));
    } catch (_) { names.push(...chunk); }
  }
  return names.sort();
}

// ─── Profile-only: Login Hours & IP Ranges ─────────────────────────────────────

async function fetchLoginHours(api, profileId) {
  try {
    const result = await api.queryAll(
      `SELECT DayOfWeek, TimeFrom, TimeTo FROM ProfileLoginHours WHERE ProfileId = '${profileId}'`
    );
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const hours = {};
    for (const day of days) {
      const rec = result.records.find(r => r.DayOfWeek === day);
      hours[day] = rec
        ? { from: fmtTime(rec.TimeFrom), to: fmtTime(rec.TimeTo) }
        : null; // null = no access that day
    }
    return hours;
  } catch (_) {
    return null;
  }
}

function fmtTime(t) {
  // Salesforce returns Time as "HH:MM:SS.000Z"
  if (!t) return null;
  return String(t).substring(0, 5);
}

async function fetchLoginIpRanges(api, profileId) {
  try {
    const result = await api.queryAll(
      `SELECT StartAddress, EndAddress, Description FROM ProfileIpRange WHERE ProfileId = '${profileId}'`
    );
    return result.records.map(r => ({
      startAddress: r.StartAddress,
      endAddress: r.EndAddress,
      description: r.Description || ''
    }));
  } catch (_) {
    return [];
  }
}

// ─── URL Normalization ─────────────────────────────────────────────────────────

/**
 * Given a parsed URL object from a browser tab, returns the canonical
 * Salesforce instance URL (https://xxx.my.salesforce.com) or null if not SF.
 */
function normalizeToInstanceUrl(url) {
  const h = url.hostname;

  // Ignore known non-API Salesforce domains
  if (h === 'login.salesforce.com' || h === 'test.salesforce.com' ||
      h === 'salesforce.com' || h === 'trailhead.salesforce.com') return null;

  // Lightning Experience (all variants):
  //   xxx.lightning.force.com               → production
  //   xxx.sandbox.lightning.force.com       → sandbox (enhanced domains)
  //   xxx.develop.lightning.force.com       → scratch/dev orgs
  //   xxx.scratch.lightning.force.com       → scratch orgs
  //   xxx.demo.lightning.force.com          → demo orgs
  //   xxx.cs100.lightning.force.com         → classic sandboxes
  // Strip everything from ".lightning." onward and map to .my.salesforce.com
  const lightningIdx = h.indexOf('.lightning.force.com');
  if (lightningIdx !== -1) {
    const sub = h.slice(0, lightningIdx);
    return `https://${sub}.my.salesforce.com`;
  }

  // VF/Community pages on force.com — skip (API goes through my.salesforce.com)
  if (h.endsWith('.force.com')) return null;

  // Standard Salesforce domains: *.my.salesforce.com, *.salesforce.com (classic),
  // *.salesforcegovcloud.com (government), *.cloudforce.com (ISV/legacy)
  if (h.endsWith('.salesforce.com') || h.endsWith('.salesforcegovcloud.com') ||
      h.endsWith('.cloudforce.com')) {
    return `https://${h}`;
  }

  return null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const FALLBACK_SYSTEM_PERMISSIONS = [
  'PermissionsApiEnabled','PermissionsViewSetup','PermissionsModifyAllData',
  'PermissionsManageUsers','PermissionsManageRoles','PermissionsManageProfilesPermissionSets',
  'PermissionsAssignPermissionSets','PermissionsViewAllData','PermissionsCustomizeApplication',
  'PermissionsManageCustomReportTypes','PermissionsEditReadonlyFields','PermissionsRunReports',
  'PermissionsViewAllUsers','PermissionsManageLeads','PermissionsTransferAnyEntity',
  'PermissionsTransferAnyCase','PermissionsTransferAnyLead','PermissionsImportLeads',
  'PermissionsManageEmailClientConfig','PermissionsAuthorApex','PermissionsManageCallCenters',
  'PermissionsViewEncryptedData','PermissionsRunFlow','PermissionsManageFlows',
  'PermissionsBulkApiHardDelete','PermissionsManageNetworks','PermissionsManageSandboxes',
  'PermissionsViewEventLogFiles','PermissionsManageDataCategories','PermissionsLightningExperienceUser',
  'PermissionsViewDeveloperName','PermissionsManageHealthCheck','PermissionsViewHealthCheck',
  'PermissionsCreateWorkspaces','PermissionsManageContentPermissions','PermissionsManageContentProperties',
  'PermissionsManageContentTypes','PermissionsManageInteraction','PermissionsEditTask',
  'PermissionsEditEvent','PermissionsActivateContract','PermissionsActivateOrder',
  'PermissionsImportCustomObjects','PermissionsManageDynamicDashboards','PermissionsManageDashboards',
  'PermissionsCreateDashboardFolders','PermissionsViewPublicDashboards','PermissionsManageReports',
  'PermissionsCreateReportFolders','PermissionsViewPublicReports','PermissionsViewMyTeamsDashboards',
  'PermissionsChatterOwnGroups','PermissionsModerateNetworkUsers','PermissionsEditPublicFilters',
  'PermissionsEditPublicTemplates','PermissionsManageMobile','PermissionsConvertLeads',
  'PermissionsPasswordNeverExpires','PermissionsManageCertificates','PermissionsGovernNetworks',
  'PermissionsViewAllForecasts','PermissionsManageForecasts','PermissionsEditActivatedOrders',
  'PermissionsInstallPackaging','PermissionsPublishPackaging','PermissionsChatterInternalUser',
  'PermissionsSendSitRequests','PermissionsViewContent','PermissionsManageEntitlements',
  'PermissionsManageBusinessHourHolidays',
];
