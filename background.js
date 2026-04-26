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
      `Not logged in to ${host}. Please open that org in Chrome and log in, then try again.`
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

  const [psResult, profileResult] = await Promise.all([
    api.query(
      'SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Label ASC'
    ),
    api.query('SELECT Id, Name FROM Profile ORDER BY Name ASC')
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
    }))
  };
}

async function fetchPermissionSetData(orgId, id, itemType = 'permissionset') {
  const { org, api } = await getOrgAndSession(orgId);

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

  // Lightning Experience: xxx.lightning.force.com → xxx.my.salesforce.com
  if (h.endsWith('.lightning.force.com')) {
    const sub = h.slice(0, h.indexOf('.lightning.force.com'));
    return `https://${sub}.my.salesforce.com`;
  }

  // VF/Community pages on force.com — skip (API still goes through my.salesforce.com)
  if (h.endsWith('.force.com')) return null;

  // Standard: *.my.salesforce.com, *.sandbox.my.salesforce.com, *.develop.my.salesforce.com, etc.
  if (h.endsWith('.salesforce.com')) {
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
