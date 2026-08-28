#!/usr/bin/env node
import { enabledSites } from './site-config.mjs';

const layer = Number(process.argv[2] || 0);
const include = enabledSites()
  .filter((site) => !layer || (site.layers || []).includes(layer))
  .map((site) => ({
    siteId: site.id,
    label: site.alertLabel || site.name,
    propertyId: site.ga4PropertyId,
    repository: site.repository,
    repositoryId: String(site.repositoryId),
    baseUrl: site.baseUrl,
  }));
if (!include.length) throw new Error(`No enabled sites for layer ${layer || 'all'}`);
console.log(JSON.stringify({ include }));
