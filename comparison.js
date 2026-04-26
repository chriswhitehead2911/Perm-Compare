/**
 * Compares an array of permission set / profile data objects.
 * Returns a structured result consumed by results.js.
 */
export function comparePermissionSets(datasets) {
  return {
    headers: datasets.map(ds => ({
      orgName: ds.orgName,
      permissionSetLabel: ds.permissionSetLabel || ds.permissionSetName,
      itemType: ds.itemType || 'permissionset'
    })),
    systemPermissions:      compareSystemPermissions(datasets),
    objectPermissions:      compareObjectPermissions(datasets),
    fieldPermissions:       compareFieldPermissions(datasets),
    tabSettings:            compareTabSettings(datasets),
    apexClassAccess:        compareListField(datasets, 'apexClassAccess'),
    vfPageAccess:           compareListField(datasets, 'vfPageAccess'),
    customPermissions:      compareListField(datasets, 'customPermissions'),
    recordTypeAccess:       compareListField(datasets, 'recordTypeAccess'),
    flowAccess:             compareListField(datasets, 'flowAccess'),
    appAccess:              compareListField(datasets, 'appAccess'),
    namedCredentialAccess:  compareListField(datasets, 'namedCredentialAccess'),
    externalDataSourceAccess: compareListField(datasets, 'externalDataSourceAccess'),
    loginHours:             compareLoginHours(datasets),
    loginIpRanges:          compareLoginIpRanges(datasets)
  };
}

// ─── System Permissions ────────────────────────────────────────────────────────

function compareSystemPermissions(datasets) {
  const allPerms = new Set();
  for (const ds of datasets) Object.keys(ds.systemPermissions || {}).forEach(p => allPerms.add(p));

  return [...allPerms].sort().map(perm => {
    const values = datasets.map(ds => {
      const v = (ds.systemPermissions || {})[perm];
      return v === undefined ? null : v;
    });
    return { name: perm, values, isDifferent: hasVariance(values) };
  });
}

// ─── Object Permissions ────────────────────────────────────────────────────────

function compareObjectPermissions(datasets) {
  const allObjects = new Set();
  for (const ds of datasets) Object.keys(ds.objectPermissions || {}).forEach(o => allObjects.add(o));

  return [...allObjects].sort().map(obj => {
    const values = datasets.map(ds => (ds.objectPermissions || {})[obj] || null);
    return { object: obj, values, isDifferent: hasVariance(values.map(v => JSON.stringify(v))) };
  });
}

// ─── Field Permissions ─────────────────────────────────────────────────────────

function compareFieldPermissions(datasets) {
  const allFields = new Set();
  for (const ds of datasets) Object.keys(ds.fieldPermissions || {}).forEach(f => allFields.add(f));

  return [...allFields].sort().map(field => {
    const values = datasets.map(ds => (ds.fieldPermissions || {})[field] || null);
    return { field, values, isDifferent: hasVariance(values.map(v => JSON.stringify(v))) };
  });
}

// ─── Tab Settings ──────────────────────────────────────────────────────────────

function compareTabSettings(datasets) {
  const allTabs = new Set();
  for (const ds of datasets) Object.keys(ds.tabSettings || {}).forEach(t => allTabs.add(t));

  return [...allTabs].sort().map(tab => {
    const values = datasets.map(ds => (ds.tabSettings || {})[tab] || 'None');
    return { tab, values, isDifferent: hasVariance(values) };
  });
}

// ─── Generic List (Apex, VF, Flows, Apps, etc.) ────────────────────────────────

function compareListField(datasets, field) {
  const allItems = new Set();
  for (const ds of datasets) (ds[field] || []).forEach(item => allItems.add(item));

  return [...allItems].sort().map(item => {
    const values = datasets.map(ds => (ds[field] || []).includes(item));
    return { name: item, values, isDifferent: hasVariance(values) };
  });
}

// ─── Login Hours (profiles only) ──────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function compareLoginHours(datasets) {
  // Only meaningful if at least one dataset has login hours
  const anyHours = datasets.some(ds => ds.loginHours !== null && ds.loginHours !== undefined);
  if (!anyHours) return [];

  return DAYS.map(day => {
    const values = datasets.map(ds => ds.loginHours ? (ds.loginHours[day] || null) : null);
    return { day, values, isDifferent: hasVariance(values.map(v => JSON.stringify(v))) };
  });
}

// ─── Login IP Ranges (profiles only) ──────────────────────────────────────────

function compareLoginIpRanges(datasets) {
  const anyRanges = datasets.some(ds => ds.loginIpRanges?.length > 0);
  if (!anyRanges) return [];

  // Key each range by "start|end" for comparison
  const allRanges = new Set();
  for (const ds of datasets) {
    (ds.loginIpRanges || []).forEach(r => allRanges.add(`${r.startAddress}|${r.endAddress}`));
  }

  return [...allRanges].sort().map(key => {
    const [startAddress, endAddress] = key.split('|');
    const values = datasets.map(ds => {
      if (!ds.loginIpRanges) return null;
      return ds.loginIpRanges.some(r => r.startAddress === startAddress && r.endAddress === endAddress);
    });
    const description = datasets
      .flatMap(ds => ds.loginIpRanges || [])
      .find(r => r.startAddress === startAddress && r.endAddress === endAddress)?.description || '';
    return { startAddress, endAddress, description, values, isDifferent: hasVariance(values) };
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function hasVariance(values) {
  const nonNull = values.filter(v => v !== null && v !== undefined);
  if (nonNull.length === 0) return false;
  return new Set(nonNull).size > 1 || nonNull.length < values.length;
}
