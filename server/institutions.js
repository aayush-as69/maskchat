// Phase 5: multi-institution support. MaskChat was hardcoded to a single
// college domain (galgotiacollege.edu.in) everywhere - this module replaces
// that with a small, explicit registry of institutions, each identified by
// its email domain, so the same deployment can serve several colleges at
// once without code changes.
//
// Matching stays fully isolated per institution by design: a seeker at one
// college is never shown mentors from another (see index.js, which filters
// every match/queue lookup by institutionId). There is no cross-institution
// pool, opt-in or otherwise - keeping that boundary hard is simpler to
// reason about and safer for a peer support product than making it
// configurable.

const DEFAULT_INSTITUTIONS = [
  { id: 'galgotias', name: 'Galgotias College', domain: 'galgotiacollege.edu.in', rateLimitPool: 'galgotias', rateLimit: 6, branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: 'moderation@galgotiacollege.edu.in' },
  { id: 'galgotias-univ', name: 'Galgotias University', domain: 'galgotiasuniversity.edu.in', rateLimitPool: 'galgotias', rateLimit: 6, branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: 'moderation@galgotiasuniversity.edu.in' },
  { id: 'demo-college', name: 'University College', domain: 'college.edu', rateLimitPool: 'demo', rateLimit: 6, branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: 'support@college.edu' },
  { id: 'campus-net', name: 'Campus Peer Network', domain: 'campus.edu', rateLimitPool: 'demo', rateLimit: 6, branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: 'support@campus.edu' },
  { id: 'student-edu', name: 'Student Network', domain: 'student.edu', rateLimitPool: 'demo', rateLimit: 6, branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' }, moderationContact: 'support@student.edu' }
];

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'institution';
}

// INSTITUTIONS env var, when set, is a JSON array of { id?, name, domain }.
// id is derived from name/domain when omitted. Falls back to the single
// legacy Galgotias entry so an existing deployment that hasn't set this
// keeps working unchanged.
export function loadInstitutions(env = process.env) {
  const raw = env.INSTITUTIONS;
  if (!raw) return DEFAULT_INSTITUTIONS;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`INSTITUTIONS is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('INSTITUTIONS must be a non-empty JSON array of {name, domain}.');
  }

  const seenIds = new Set();
  const seenDomains = new Set();
  const institutions = parsed.map((entry, index) => {
    const domain = String(entry?.domain || '').trim().toLowerCase();
    const name = String(entry?.name || '').trim();
    if (!domain || !name) {
      throw new Error(`INSTITUTIONS[${index}] must have a non-empty "name" and "domain".`);
    }
    const id = slugify(entry?.id || name);
    if (seenIds.has(id)) throw new Error(`INSTITUTIONS has a duplicate institution id: "${id}".`);
    if (seenDomains.has(domain)) throw new Error(`INSTITUTIONS has a duplicate domain: "${domain}".`);
    seenIds.add(id);
    seenDomains.add(domain);
    const rateLimit = Number(entry?.rateLimit || 6);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) throw new Error(`INSTITUTIONS[${index}].rateLimit must be an integer from 1 to 1000.`);
    const branding = entry?.branding || {};
    return {
      id, name, domain,
      rateLimitPool: String(entry?.rateLimitPool || id),
      rateLimit,
      branding: {
        logoUrl: String(branding.logoUrl || '').trim().slice(0, 500),
        primary: String(branding.primary || '#0b7b9e').trim().slice(0, 32),
        secondary: String(branding.secondary || '#3c6e71').trim().slice(0, 32)
      },
      moderationContact: String(entry?.moderationContact || '').trim().slice(0, 160) || null
    };
  });

  return institutions;
}

// Institutions are matched by exact domain suffix (`@domain`) rather than a
// substring check, so e.g. "notgalgotiacollege.edu.in" never matches
// "galgotiacollege.edu.in".
export function resolveInstitutionByEmail(email, institutions, { allowDemoFallback = false } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at === -1) return null;
  const emailDomain = normalized.slice(at + 1);
  const found = institutions.find((institution) => emailDomain === institution.domain);
  if (found) return found;
  // Unknown domains never become implicit institutions unless the caller opts
  // in. index.js only does so in AUTH_MODE=development, so any campus email
  // works locally while production and SSO stay strict.
  if (!allowDemoFallback || !emailDomain) return null;
  return {
    id: slugify(emailDomain.split('.')[0] || 'campus'),
    name: emailDomain.split('.')[0].toUpperCase() + ' Campus',
    domain: emailDomain,
    rateLimitPool: 'demo',
    rateLimit: 6,
    branding: { logoUrl: '', primary: '#0b7b9e', secondary: '#3c6e71' },
    moderationContact: `support@${emailDomain}`
  };
}

export function resolveInstitutionById(id, institutions) {
  return institutions.find((institution) => institution.id === id) || null;
}

// What's safe to expose over GET /api/institutions: id/name/domain for
// every supported college, so the login form can show a helpful hint
// ("Use your college email - we support: ...") without hardcoding one
// domain into the client. There's nothing sensitive in this list - it's
// the same information a prospective user needs to know before typing
// their email in.
export function publicInstitutionList(institutions) {
  return institutions.map(({ id, name, domain, branding, moderationContact }) => ({ id, name, domain, branding, moderationContact }));
}
