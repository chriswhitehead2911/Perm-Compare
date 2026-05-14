# Perm Compare — Salesforce Permission Set Comparator

A Chrome extension for comparing Salesforce permission sets, profiles, and permission set groups side-by-side across multiple orgs.

## Features

- **Compare anything vs anything** — permission sets, profiles, and permission set groups (PSGs) from any two connected orgs
- **Permission Set Group support** — computes effective permissions by unioning all member permission sets, with muting permission set support
- **14 permission categories** — system permissions, object & field permissions, tab settings, Apex classes, VF pages, flows, apps, custom permissions, record types, named credentials, external data sources, login hours, and login IP ranges
- **Smart diff view** — opens pre-filtered to differences only; tab badges show diff counts at a glance
- **Filter & search** — filter any section by name in real time
- **Export** — download the current section as CSV or the full comparison as a self-contained HTML report
- **Zero setup** — uses your existing Salesforce browser sessions; no Connected App or OAuth configuration required

## Installation

This extension is not on the Chrome Web Store. Install it as an unpacked extension:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select the repository folder

## Usage

1. Log in to your Salesforce orgs in Chrome as you normally would
2. Click the extension icon to open the popup
3. Click **Scan Open Salesforce Tabs** — the extension will detect any orgs you're logged into
4. Click **Add** next to each org you want to compare (you need at least two)
5. Select a profile, permission set, or permission set group for each org
6. Click **Run Comparison** — results open in a new tab

### Connecting orgs manually

If an org isn't detected by the scan, click **+ Add by URL** and paste the org's instance URL (e.g. `mycompany.my.salesforce.com`). You must already be logged in to that org in Chrome.

## Permissions used

| Permission | Why |
|---|---|
| `storage` | Saves connected org list between sessions |
| `cookies` | Reads the Salesforce session cookie to authenticate API calls |
| `tabs` | Scans open tabs to detect logged-in Salesforce orgs |
| `*.salesforce.com`, `*.force.com` | Makes Salesforce REST API calls using your existing session |

No data is sent to any server other than your own Salesforce orgs.

## Supported Salesforce URL formats

The extension recognises all common Salesforce domain patterns:

- `*.my.salesforce.com` (production and sandboxes with enhanced domains)
- `*.lightning.force.com` (Lightning Experience — all variants including develop, scratch, demo, and classic instance subdomains)
- `*.salesforce.com` (classic instance URLs like `na100.salesforce.com`)
- `*.salesforcegovcloud.com` (Government Cloud)
- `*.cloudforce.com` (legacy ISV domains)

## Limitations

- Requires you to be logged in to each org in the same Chrome browser
- Org sessions are not stored — if a session expires you'll need to reload that Salesforce tab
- Login hours and login IP ranges are only available when comparing profiles
- Permission Set Group comparisons do not include login hours or IP ranges (PSG-level data only)
