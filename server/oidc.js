import crypto from 'node:crypto';

const JWKS_CACHE_TTL_MS = 5 * 60_000;
const jwksCache = new Map();

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT.');
  let header; let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Malformed JWT payload.'); }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
}

function jwkToKey(jwk) {
  if (!jwk?.kty) throw new Error('Invalid JWKS key.');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

function verifyJwtSignature(jwt, jwk) {
  const { header, signingInput, signature } = jwt;
  const key = jwkToKey(jwk);
  const algorithms = {
    RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512',
    PS256: 'RSA-SHA256', PS384: 'RSA-SHA384', PS512: 'RSA-SHA512',
    ES256: 'sha256', ES384: 'sha384', ES512: 'sha512'
  };
  const algorithm = algorithms[header.alg];
  if (!algorithm) throw new Error(`Unsupported JWT algorithm: ${header.alg || 'missing'}.`);
  const verifier = crypto.createVerify(algorithm);
  verifier.update(signingInput);
  verifier.end();
  const padding = header.alg.startsWith('PS') ? crypto.constants.RSA_PSS_PADDING : undefined;
  const saltLength = header.alg.startsWith('PS') ? crypto.constants.RSA_PSS_SALTLEN_DIGEST : undefined;
  // JWT ES* signatures are raw r||s (IEEE P1363), not the DER Node expects by default.
  const isEc = header.alg.startsWith('ES');
  const options = padding ? { key, padding, saltLength } : isEc ? { key, dsaEncoding: 'ieee-p1363' } : key;
  if (!verifier.verify(options, signature)) throw new Error('JWT signature verification failed.');
}

export function loadOidcConfig(env = process.env) {
  const enabled = String(env.OIDC_ENABLED || '').toLowerCase() === '1' || String(env.OIDC_ENABLED || '').toLowerCase() === 'true';
  const issuer = String(env.OIDC_ISSUER || '').trim().replace(/\/$/, '');
  const clientId = String(env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = String(env.OIDC_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.OIDC_REDIRECT_URI || '').trim();
  const postLoginRedirect = String(env.OIDC_POST_LOGIN_REDIRECT || env.CLIENT_ORIGIN || '').trim();
  const allowedDomains = String(env.OIDC_ALLOWED_DOMAINS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const stateSecret = String(env.OIDC_STATE_SECRET || env.IDENTITY_VERIFICATION_SECRET || '').trim();
  const scope = String(env.OIDC_SCOPE || 'openid email profile').trim();
  const maxAgeSeconds = Number(env.OIDC_MAX_AGE_SECONDS || 600);
  if (!enabled) return { enabled: false };
  if (!issuer || !clientId || !redirectUri || !stateSecret || stateSecret.length < 32) throw new Error('OIDC requires OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_REDIRECT_URI and a 32+ character OIDC_STATE_SECRET.');
  for (const urlValue of [issuer, redirectUri, postLoginRedirect].filter(Boolean)) {
    const parsed = new URL(urlValue);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new Error('OIDC issuer and redirect URLs must use HTTPS outside local development.');
    }
  }
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 3600) throw new Error('OIDC_MAX_AGE_SECONDS must be between 60 and 3600.');
  return { enabled: true, issuer, clientId, clientSecret, redirectUri, postLoginRedirect, allowedDomains, stateSecret, scope, maxAgeSeconds };
}

export function createOidcState(config, now = Date.now()) {
  const ttl = Math.max(60, Math.min(3600, Number(config.maxAgeSeconds) || 600));
  const payload = { v: 1, nonce: crypto.randomBytes(24).toString('base64url'), verifier: crypto.randomBytes(48).toString('base64url'), iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttl };
  const encoded = b64urlJson(payload);
  const sig = crypto.createHmac('sha256', config.stateSecret).update(encoded).digest('base64url');
  return { state: `${encoded}.${sig}`, ...payload };
}

export function verifyOidcState(state, config, now = Date.now(), expectedNonce = '') {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) throw new Error('Invalid OIDC state.');
  const [encoded, signature] = parts;
  const expected = crypto.createHmac('sha256', config.stateSecret).update(encoded).digest('base64url');
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid OIDC state signature.');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('Invalid OIDC state payload.'); }
  const nowSec = Math.floor(now / 1000);
  if (!payload?.nonce || !payload?.verifier || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat) || payload.exp <= nowSec || payload.iat > nowSec + 30) throw new Error('Expired OIDC state.');
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('OIDC state is not bound to this browser session.');
  return payload;
}

export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export async function discoverOidc(config) {
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}.`);
  const doc = await response.json();
  if (doc.issuer !== config.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('OIDC discovery document is missing required endpoints or has an issuer mismatch.');
  return doc;
}

export function buildAuthorizationUrl(config, discovery, stateData) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', stateData.state);
  url.searchParams.set('nonce', stateData.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(stateData.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('max_age', String(config.maxAgeSeconds));
  return url.toString();
}

async function exchangeCode(config, discovery, code, verifier) {
  const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: verifier });
  if (config.clientSecret) params.set('client_secret', config.clientSecret);
  const response = await fetch(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: params, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OIDC token exchange failed with HTTP ${response.status}.`);
  return response.json();
}

async function fetchJwks(uri, { forceRefresh = false } = {}) {
  const cached = jwksCache.get(uri);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(uri, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`OIDC JWKS request failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('OIDC JWKS response is invalid.');
  jwksCache.set(uri, { keys: body.keys, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
  return body.keys;
}

export async function verifyIdToken(idToken, config, discovery, expectedNonce, now = Date.now()) {
  const jwt = parseJwt(idToken);
  if (jwt.header.typ && jwt.header.typ !== 'JWT') throw new Error('Unexpected ID token type.');
  let keys = await fetchJwks(discovery.jwks_uri);
  let key = keys.find(k => k.kid === jwt.header.kid && (!k.alg || k.alg === jwt.header.alg));
  if (!key) {
    keys = await fetchJwks(discovery.jwks_uri, { forceRefresh: true });
    key = keys.find(k => k.kid === jwt.header.kid && (!k.alg || k.alg === jwt.header.alg));
  }
  if (!key) throw new Error('No matching OIDC signing key.');
  verifyJwtSignature(jwt, key);
  const claims = jwt.payload;
  const nowSec = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new Error('OIDC issuer claim mismatch.');
  if (!audience.includes(config.clientId)) throw new Error('OIDC audience claim mismatch.');
  if (audience.length > 1 && claims.azp !== config.clientId) throw new Error('OIDC authorized-party claim mismatch.');
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(iat) || exp <= nowSec || iat > nowSec + 60) throw new Error('OIDC ID token is expired or issued in the future.');
  if (claims.auth_time !== undefined && (!Number.isFinite(Number(claims.auth_time)) || nowSec - Number(claims.auth_time) > config.maxAgeSeconds)) throw new Error('OIDC authentication is too old.');
  if (claims.nonce !== expectedNonce) throw new Error('OIDC nonce mismatch.');
  if (claims.email_verified === false || String(claims.email_verified).toLowerCase() === 'false') throw new Error('Institution email is not verified by the identity provider.');
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('OIDC ID token does not contain an email address.');
  const subject = String(claims.sub || '').trim();
  if (!subject) throw new Error('OIDC ID token does not contain a subject.');
  return { email, subject, claims };
}

export async function authenticateOidcCallback(config, query, expectedStateNonce = '') {
  if (query?.error) throw new Error(`Institution sign-in was not completed: ${query.error_description || query.error}.`);
  const state = verifyOidcState(query?.state, config, Date.now(), expectedStateNonce);
  const discovery = await discoverOidc(config);
  const tokens = await exchangeCode(config, discovery, String(query?.code || ''), state.verifier);
  if (!tokens.id_token) throw new Error('OIDC provider did not return an ID token.');
  const identity = await verifyIdToken(tokens.id_token, config, discovery, state.nonce);
  return { identity, expiresIn: Math.min(300, Number(tokens.expires_in) || 300) };
}
