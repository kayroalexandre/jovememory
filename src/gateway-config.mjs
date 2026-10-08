import { readFileSync } from 'node:fs';
import { ensure, validateEndpoint } from './config.mjs';

// The gateway is the only component that speaks OAuth. Its entire authority is the single
// scoped upstream profile token, so every credential it accepts is explicit and private.
export const GATEWAY_SCOPES = ['memory:read'];
const readSecret = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return undefined; } };
const number = (env, key, fallback, min, max) => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  ensure(Number.isInteger(value) && value >= min && value <= max, 'CONFIG', `${key} must be an integer between ${min} and ${max}.`);
  return value;
};
const passwordPattern = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{32,64})$/;
const clientIdPattern = /^[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{1,512}$/;
function staticClients(raw) {
  if (!raw?.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error('STATIC_OAUTH_CLIENTS must be a JSON array of {client_id,client_name,redirect_uris}.'), { code: 'CONFIG' }); }
  ensure(Array.isArray(parsed) && parsed.length <= 16, 'CONFIG', 'STATIC_OAUTH_CLIENTS accepts at most 16 entries.');
  return parsed.map(entry => {
    ensure(entry && typeof entry === 'object' && clientIdPattern.test(String(entry.client_id ?? '')) && !String(entry.client_id).includes('://'),
      'CONFIG', 'Each static client needs a non-URL client_id.');
    const redirectUris = entry.redirect_uris;
    ensure(Array.isArray(redirectUris) && redirectUris.length >= 1 && redirectUris.length <= 16 &&
      redirectUris.every(uri => typeof uri === 'string' && uri.length <= 1024 && /^https:\/\//.test(uri)),
    'CONFIG', 'Static clients declare 1 to 16 absolute HTTPS redirect_uris.');
    const clientName = entry.client_name === undefined ? String(entry.client_id) : String(entry.client_name);
    ensure(clientName.length <= 128 && /^[A-Za-z0-9 ._@()-]+$/.test(clientName), 'CONFIG', 'Static client names are short ASCII labels.');
    return { clientId: String(entry.client_id), clientName, redirectUris };
  });
}
export function gatewayConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const publicUrl = new URL(env.PUBLIC_URL || 'http://127.0.0.1:3100');
  ensure(publicUrl.pathname === '/' && !publicUrl.search && !publicUrl.hash && !publicUrl.username && !publicUrl.password,
    'CONFIG', 'PUBLIC_URL must be a bare origin.');
  ensure(!production || publicUrl.protocol === 'https:', 'CONFIG', 'Production requires an HTTPS PUBLIC_URL.');
  const upstream = new URL(env.UPSTREAM_MCP_URL || 'http://127.0.0.1:3007/mcp');
  validateEndpoint(upstream.href, production);
  ensure(upstream.pathname === '/mcp', 'CONFIG', 'UPSTREAM_MCP_URL must address the MCP endpoint path.');
  const upstreamToken = (env.UPSTREAM_BEARER_TOKEN?.trim() || readSecret(env.UPSTREAM_BEARER_TOKEN_FILE) || '').trim();
  ensure(/^[A-Za-z0-9_-]{43,256}$/.test(upstreamToken), 'CONFIG', 'The upstream profile token must be an explicit private credential.');
  const signingKey = (env.OAUTH_SIGNING_KEY || '').trim();
  ensure(/^[a-f0-9]{64}$/.test(signingKey), 'CONFIG', 'OAUTH_SIGNING_KEY must be a generated 256-bit hex key.');
  const passwordHash = (env.OPERATOR_PASSWORD_HASH || '').trim();
  ensure(passwordPattern.test(passwordHash), 'CONFIG', 'OPERATOR_PASSWORD_HASH must come from scripts/gateway-password.mjs.');
  return {
    production,
    // The issuer doubles as the RFC 8707 resource identifier and the access-token audience.
    issuer: publicUrl.origin,
    upstream,
    upstreamToken,
    signingKey: Buffer.from(signingKey, 'hex'),
    passwordHash,
    scopes: GATEWAY_SCOPES,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    port: number(env, 'PORT', production ? 3100 : 3100, 1, 65535),
    accessTtlSeconds: number(env, 'ACCESS_TOKEN_TTL_SECONDS', 43200, 300, 86400),
    refreshTtlSeconds: number(env, 'REFRESH_TOKEN_TTL_SECONDS', 2592000, 3600, 7776000),
    codeTtlSeconds: number(env, 'AUTHORIZATION_CODE_TTL_SECONDS', 120, 30, 600),
    ticketTtlSeconds: number(env, 'LOGIN_TICKET_TTL_SECONDS', 300, 60, 900),
    upstreamTimeoutMs: number(env, 'UPSTREAM_TIMEOUT_MS', 240000, 1000, 300000),
    maxInflight: number(env, 'MAX_INFLIGHT_REQUESTS', 16, 1, 128),
    loginAttempts: number(env, 'LOGIN_ATTEMPTS', 5, 1, 100),
    // Login throttling keys on the effective client address, so the edge hop must be trusted.
    trustProxy: env.TRUST_PROXY === undefined ? production : env.TRUST_PROXY === 'true',
    staticClients: staticClients(env.STATIC_OAUTH_CLIENTS)
  };
}
