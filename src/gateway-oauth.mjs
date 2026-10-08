import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { ensure } from './config.mjs';

const scrypt = promisify(scryptCallback);
const CODE_AUDIENCE = 'jovememory-gateway/authorization-code';
const TICKET_AUDIENCE = 'jovememory-gateway/login-ticket';
const REFRESH_AUDIENCE = 'jovememory-gateway/refresh-token';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const CIMD_MAX_BYTES = 65536;

// RFC 9728 / RFC 8414 documents. `resource` is the gateway origin, which is also the audience
// of every access token and the value ChatGPT echoes as the RFC 8707 `resource` parameter.
export function protectedResourceMetadata(c) {
  return {
    resource: c.issuer,
    authorization_servers: [c.issuer],
    scopes_supported: c.scopes,
    bearer_methods_supported: ['header'],
    resource_documentation: `${c.issuer}/.well-known/oauth-protected-resource`
  };
}
export function authorizationServerMetadata(c) {
  return {
    issuer: c.issuer,
    authorization_endpoint: `${c.issuer}/authorize`,
    token_endpoint: `${c.issuer}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: c.scopes
  };
}
export function pkceChallenge(verifier) {
  ensure(typeof verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier), 'OAUTH', 'The code verifier is malformed.');
  return createHash('sha256').update(verifier).digest('base64url');
}
function assertChallenge(verifier, challenge) {
  ensure(pkceChallenge(verifier) === challenge, 'OAUTH', 'The code verifier does not match the challenge.');
}
export async function hashPassword(password) {
  ensure(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'INPUT', 'Use an operator password of 12 to 256 characters.');
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(stored, candidate) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  if (typeof candidate !== 'string' || candidate.length > 256) return false;
  try {
    const expectedBytes = Buffer.from(expected, 'base64url');
    const key = await scrypt(candidate.normalize('NFKC'), Buffer.from(salt, 'base64url'), expectedBytes.length, { N: Number(N), r: Number(r), p: Number(p) });
    return expectedBytes.length === SCRYPT.keylen && timingSafeEqual(key, expectedBytes);
  } catch { return false; }
}
async function sign(c, audience, claims, ttlSeconds, typ = 'JWT') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ }).setIssuer(c.issuer).setAudience(audience)
    .setSubject(claims.sub ?? 'operator').setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + ttlSeconds)
    .sign(c.signingKey);
}
async function verify(c, audience, token, typ) {
  ensure(typeof token === 'string' && token.length >= 32 && token.length <= 4096, 'OAUTH', 'The token is malformed.');
  const { payload } = await jwtVerify(token, c.signingKey, { issuer: c.issuer, audience, algorithms: ['HS256'], typ, requiredClaims: ['exp', 'iat', 'jti', 'sub'] });
  return payload;
}
export const issueAuthorizationCode = (c, request) =>
  sign(c, CODE_AUDIENCE, { sub: 'operator', client_id: request.clientId, redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge, scope: request.scope, resource: request.resource }, c.codeTtlSeconds);
export async function redeemAuthorizationCode(c, code, { codeVerifier, redirectUri, clientId, resource }) {
  const payload = await verify(c, CODE_AUDIENCE, code, 'JWT').catch(() => { throw Object.assign(new Error('The authorization code is invalid or expired.'), { code: 'OAUTH' }); });
  ensure(payload.client_id === clientId && payload.redirect_uri === redirectUri, 'OAUTH', 'The authorization code was issued for another client.');
  assertChallenge(codeVerifier, payload.code_challenge);
  ensure(payload.resource === resource, 'OAUTH', 'The authorization code was issued for another resource.');
  return payload;
}
export const issueLoginTicket = (c, request) =>
  sign(c, TICKET_AUDIENCE, { sub: 'operator', request: { ...request, ticket: undefined }, scope: request.scope, resource: request.resource }, c.ticketTtlSeconds);
export async function redeemLoginTicket(c, ticket) {
  const payload = await verify(c, TICKET_AUDIENCE, ticket, 'JWT').catch(() => { throw Object.assign(new Error('The login request expired. Restart the connection.'), { code: 'OAUTH' }); });
  ensure(payload.request && typeof payload.request === 'object' && payload.request.clientId, 'OAUTH', 'The login request is malformed.');
  return payload.request;
}
async function tokenPair(c, { clientId, scope, subject = 'operator' }) {
  ensure(c.scopes.includes(scope), 'OAUTH', 'The requested scope is not supported.');
  const accessToken = await sign(c, c.issuer, { sub: subject, client_id: clientId, scope, resource: c.issuer }, c.accessTtlSeconds, 'at+jwt');
  const refreshToken = await sign(c, REFRESH_AUDIENCE, { sub: subject, client_id: clientId, scope, resource: c.issuer }, c.refreshTtlSeconds);
  return { access_token: accessToken, token_type: 'Bearer', expires_in: c.accessTtlSeconds, refresh_token: refreshToken, scope };
}
export const issueTokens = (c, claims) => tokenPair(c, claims);
export async function rotateTokens(c, refreshToken, { clientId, resource }) {
  const payload = await verify(c, REFRESH_AUDIENCE, refreshToken, 'JWT').catch(() => { throw Object.assign(new Error('The refresh token is invalid or expired.'), { code: 'OAUTH' }); });
  ensure(payload.client_id === clientId, 'OAUTH', 'The refresh token was issued for another client.');
  ensure(payload.resource === resource, 'OAUTH', 'The refresh token was issued for another resource.');
  return tokenPair(c, { clientId: payload.client_id, scope: payload.scope, subject: payload.sub });
}
export async function verifyAccessToken(c, header) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,4096})$/.exec(String(header || ''));
  if (!match) return null;
  const payload = await verify(c, c.issuer, match[1], 'at+jwt').catch(() => null);
  if (!payload || !c.scopes.includes(payload.scope) || payload.resource !== c.issuer) return null;
  return { subject: payload.sub, scope: payload.scope, clientId: payload.client_id, expiresAt: payload.exp };
}
const blockedIpv4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^192\.0\.2\./, /^198\.1[89]\./, /^198\.51\.100\./, /^203\.0\.113\./, /^22[4-9]\./, /^23[0-9]\./, /^24\d\./, /^25[0-5]\./];
function publicAddress(address) {
  const kind = isIP(address);
  if (!kind) return false;
  if (isIPv4(address)) return !blockedIpv4.some(re => re.test(address));
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return publicAddress(mapped[1]);
  if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return false;
  return true;
}
async function readCimd(fetchImpl, url) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  ensure(response.ok, 'OAUTH', 'The client metadata document is unavailable.');
  const declared = Number(response.headers.get('content-length'));
  ensure(!(declared > CIMD_MAX_BYTES), 'OAUTH', 'The client metadata document is too large.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    ensure(size <= CIMD_MAX_BYTES, 'OAUTH', 'The client metadata document is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let document;
  try { document = JSON.parse(text); } catch { throw Object.assign(new Error('The client metadata document is not JSON.'), { code: 'OAUTH' }); }
  ensure(document && typeof document === 'object' && !Array.isArray(document), 'OAUTH', 'The client metadata document is malformed.');
  return document;
}
// ChatGPT registers itself with Client ID Metadata Documents; static clients cover every other
// product. Both paths must publish the exact redirect URI the authorization request asked for.
export function createClientRegistry({ fetchImpl = globalThis.fetch, lookup = dnsLookup, ttlMs = 300000, maxEntries = 64 } = {}) {
  const cache = new Map();
  return async function clientRegistration(c, clientId, redirectUri) {
    ensure(typeof clientId === 'string' && clientId.length >= 1 && clientId.length <= 512, 'OAUTH', 'The client_id is missing or malformed.');
    ensure(typeof redirectUri === 'string' && redirectUri.length >= 8 && redirectUri.length <= 1024, 'OAUTH', 'The redirect_uri is missing or malformed.');
    let target;
    try { target = new URL(redirectUri); } catch { throw Object.assign(new Error('The redirect_uri is not an absolute URI.'), { code: 'OAUTH' }); }
    ensure(target.protocol === 'https:' || (target.hostname === '127.0.0.1' && target.protocol === 'http:'),
      'OAUTH', 'The redirect_uri must be absolute HTTPS.');
    const staticClient = c.staticClients.find(entry => entry.clientId === clientId);
    if (staticClient) {
      ensure(staticClient.redirectUris.includes(redirectUri), 'OAUTH', 'The redirect_uri is not registered for this client.');
      return { clientId, clientName: staticClient.clientName, source: 'static' };
    }
    ensure(clientId.startsWith('https://'), 'OAUTH', 'Unknown client_id. Register it explicitly.');
    const cacheKey = `${clientId}|${redirectUri}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    const documentUrl = new URL(clientId);
    ensure(!documentUrl.search && !documentUrl.hash && !documentUrl.username && !documentUrl.password, 'OAUTH', 'The client_id document URL must be bare.');
    const addresses = await lookup(documentUrl.hostname, { all: true }).catch(() => []);
    ensure(addresses.length > 0 && addresses.every(entry => publicAddress(entry.address)), 'OAUTH', 'The client_id document host must be a public HTTPS origin.');
    const document = await readCimd(fetchImpl, documentUrl);
    const redirectUris = document.redirect_uris;
    ensure(Array.isArray(redirectUris) && redirectUris.length >= 1 && redirectUris.length <= 32 &&
      redirectUris.every(uri => typeof uri === 'string' && /^https:\/\//.test(uri)), 'OAUTH', 'The client metadata document must publish HTTPS redirect_uris.');
    ensure(redirectUris.includes(redirectUri), 'OAUTH', 'The redirect_uri is not registered for this client.');
    const clientName = typeof document.client_name === 'string' && document.client_name.length <= 128 && document.client_name.trim()
      ? document.client_name.slice(0, 128) : clientId;
    const value = { clientId, clientName, source: 'cimd' };
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value, expires: Date.now() + ttlMs });
    return value;
  };
}
// Login throttling is per process and per client address; Railway runs a single replica.
export function createRateLimiter({ limit = 5, windowMs = 60000, maxEntries = 8192 } = {}) {
  const entries = new Map();
  return {
    attempt(key, now = Date.now()) {
      const previous = entries.get(key);
      const state = previous && previous.reset > now ? previous : { count: 0, reset: now + windowMs };
      state.count += 1;
      entries.set(key, state);
      if (entries.size > maxEntries) for (const [candidate, value] of entries) if (value.reset <= now) entries.delete(candidate);
      return { allowed: state.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((state.reset - now) / 1000)) };
    },
    forget(key) { entries.delete(key); }
  };
}
