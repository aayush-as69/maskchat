// Phase 13: admin-controlled, privacy-safe resource allowlist.
// Arbitrary links/files remain blocked in chat; only these approved resources are shown.
const DEFAULT_RESOURCES = [
  { id: 'dsa-roadmap', title: 'DSA Roadmap', description: 'A structured path for learning data structures and algorithms.', url: 'https://roadmap.sh/datastructures', topics: ['Data Structures', 'Algorithms'], institutionIds: ['*'] },
  { id: 'sql-practice', title: 'SQL Practice', description: 'Practice queries and database fundamentals.', url: 'https://sqlbolt.com/', topics: ['DBMS', 'SQL'], institutionIds: ['*'] },
  { id: 'normalization', title: 'DBMS — Normalization', description: 'A concise reference for normalization concepts.', url: 'https://www.geeksforgeeks.org/dbms/database-normalization-normal-forms/', topics: ['DBMS'], institutionIds: ['*'] }
];
export function loadResources(env = process.env) {
  if (!env.RESOURCES) return DEFAULT_RESOURCES;
  const parsed = JSON.parse(env.RESOURCES);
  if (!Array.isArray(parsed)) throw new Error('RESOURCES must be a JSON array.');
  return parsed.map((r, i) => ({
    id: String(r.id || `resource-${i + 1}`).slice(0, 80),
    title: String(r.title || '').slice(0, 120),
    description: String(r.description || '').slice(0, 300),
    url: String(r.url || '').slice(0, 500),
    topics: Array.isArray(r.topics) ? r.topics.map(String).slice(0, 12) : [],
    institutionIds: Array.isArray(r.institutionIds) && r.institutionIds.length ? r.institutionIds.map(String) : ['*']
  })).filter(r => r.title && /^https:\/\//i.test(r.url));
}
export function resourcesFor(resources, institutionId, tags = []) {
  const wanted = new Set((tags || []).map(String).map(x => x.toLowerCase()));
  return resources.filter(r => (r.institutionIds.includes('*') || r.institutionIds.includes(institutionId)) && (!r.topics.length || r.topics.some(t => wanted.has(t.toLowerCase()))));
}
