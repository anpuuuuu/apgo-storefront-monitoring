import { readFileSync } from 'node:fs';

export const sitesConfig = JSON.parse(readFileSync(new URL('../config/sites.json', import.meta.url), 'utf8'));

export function enabledSites() {
  return (sitesConfig.sites || []).filter((site) => site.enabled && site.type === 'shopify');
}

export function getSite(siteId = process.env.MONITOR_SITE_ID || '') {
  const candidates = enabledSites();
  const site = siteId ? candidates.find((entry) => entry.id === siteId) : candidates[0];
  if (!site) throw new Error(`TEST_CONFIG_STALE: unknown or disabled site ${siteId || '(none)'}`);
  return site;
}

export function siteLayer(siteId, layer) {
  return `${siteId}:${layer}`;
}

export function assertSource(site, { repository, repositoryId, sha } = {}) {
  if (repository && repository !== site.repository) {
    throw new Error(`TEST_CONFIG_STALE: source repository ${repository} does not match ${site.repository}`);
  }
  if (repositoryId && String(repositoryId) !== String(site.repositoryId)) {
    throw new Error(`TEST_CONFIG_STALE: source repository id ${repositoryId} does not match ${site.repositoryId}`);
  }
  if (sha && !/^[0-9a-f]{40}$/i.test(String(sha))) {
    throw new Error(`TEST_CONFIG_STALE: source SHA is not a full immutable commit: ${sha}`);
  }
  return site;
}
