import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VERSION, ensure, safeError } from './config.mjs';
import { gatewayConfig } from './gateway-config.mjs';
import { authorizationServerMetadata, createClientRegistry, createRateLimiter, issueAuthorizationCode, issueLoginTicket,
  issueTokens, protectedResourceMetadata, redeemAuthorizationCode, redeemLoginTicket, rotateTokens, verifyAccessToken,
  verifyPassword } from './gateway-oauth.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const fault = (code, message) => Object.assign(new Error(message), { code });
const oauthError = (res, status, error, description) => res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
const resourceParameter = (c, value) => {
  const requested = value === undefined || value === '' ? c.issuer : String(value);
  ensure(requested === c.issuer, 'OAUTH', 'The resource parameter must identify this MCP server.');
  return requested;
};
function authorizeRequest(c, query) {
  ensure(query.response_type === 'code', 'OAUTH', 'Only the authorization code response type is supported.');
  const state = query.state === undefined ? '' : String(query.state);
  ensure(state.length >= 1 && state.length <= 512, 'OAUTH', 'The state parameter is required.');
  ensure(query.code_challenge_method === 'S256', 'OAUTH', 'Only the S256 code challenge method is supported.');
  ensure(typeof query.code_challenge === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge), 'OAUTH', 'The code challenge is missing or malformed.');
  const requested = String(query.scope ?? c.scopes.join(' ')).trim().split(/\s+/).filter(Boolean);
  ensure(requested.length > 0 && requested.every(scope => c.scopes.includes(scope)), 'OAUTH', 'The requested scope is not supported.');
  return {
    clientId: String(query.client_id ?? ''),
    redirectUri: String(query.redirect_uri ?? ''),
    codeChallenge: query.code_challenge,
    state,
    scope: requested.join(' '),
    resource: resourceParameter(c, query.resource)
  };
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title></head><body>` +
    `<main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}
const loginPage = ({ client, request, ticket, notice }) => page('Jove Memory connector',
  `<p>${escapeHtml(client.clientName)} is requesting <code>${escapeHtml(request.scope)}</code> on the Jove Memory MCP server.</p>` +
  `<form method="post" action="/authorize"><input type="hidden" name="ticket" value="${escapeHtml(ticket)}">` +
  `<p><label>Operator password<br><input type="password" name="password" autocomplete="current-password" required></label></p>` +
  `<p><button type="submit">Authorize</button></p></form>` +
  (notice ? `<p role="alert">${escapeHtml(notice)}</p>` : '<p>The password never leaves this form and is never placed in a URL.</p>'));
const errorPage = message => page('Jove Memory connector', `<p role="alert">${escapeHtml(message)}</p><p>Start again from the ChatGPT connector page.</p>`);

export function createGatewayApp(c, deps = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', c.trustProxy);
  const registry = deps.clientRegistry ?? createClientRegistry();
  const limiter = deps.rateLimiter ?? createRateLimiter({ limit: c.loginAttempts });
  const upstreamFetch = deps.fetch ?? globalThis.fetch;
  const allowedHosts = [new URL(c.issuer).hostname, 'localhost', '127.0.0.1'];
  let inflight = 0;
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    const host = req.headers.host?.split(':')[0];
    if (!allowedHosts.includes(host) && !(req.path === '/health' && !req.headers.origin)) return res.status(403).json({ error: 'Unrecognized host' });
    if (req.headers.origin && req.headers.origin !== c.issuer) return res.status(403).json({ error: 'Unrecognized origin' });
    next();
  });
  const challenge = `Bearer resource_metadata="${c.issuer}/.well-known/oauth-protected-resource", scope="${c.scopes.join(' ')}"`;
  app.get('/health', (req, res) => res.json({ status: 'ready', version: VERSION, resource: c.issuer }));
  const protectedResource = (req, res) => res.json(protectedResourceMetadata(c));
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
  const authorizationServer = (req, res) => res.json(authorizationServerMetadata(c));
  app.get('/.well-known/oauth-authorization-server', authorizationServer);
  app.get('/.well-known/oauth-authorization-server/mcp', authorizationServer);
  // RFC 6749 keeps a failed request local whenever the client or redirect URI is not trustworthy.
  app.get('/authorize', async (req, res) => {
    let request, client;
    try { request = authorizeRequest(c, req.query); }
    catch (error) { return res.status(400).type('html').send(errorPage(safeError(error).message)); }
    try { client = await registry(c, request.clientId, request.redirectUri); }
    catch (error) { return res.status(400).type('html').send(errorPage(safeError(error).message)); }
    res.type('html').send(loginPage({ client, request, ticket: await issueLoginTicket(c, request), notice: null }));
  });
  app.post('/authorize', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    let request;
    try { request = await redeemLoginTicket(c, String(req.body?.ticket ?? '')); }
    catch (error) { return res.status(400).type('html').send(errorPage(safeError(error).message)); }
    const key = String(req.ip || 'unknown');
    const gate = limiter.attempt(key);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return res.status(429).type('html').send(errorPage('Too many attempts. Wait before reconnecting.'));
    }
    if (!await verifyPassword(c.passwordHash, String(req.body?.password ?? ''))) {
      let clientName = 'The requesting client';
      try { clientName = (await registry(c, request.clientId, request.redirectUri)).clientName; } catch { /* keep the generic label */ }
      return res.status(401).type('html').send(loginPage({ client: { clientName }, request,
        ticket: String(req.body?.ticket ?? ''), notice: 'Authentication failed.' }));
    }
    limiter.forget(key);
    const location = new URL(request.redirectUri);
    location.searchParams.set('code', await issueAuthorizationCode(c, request));
    location.searchParams.set('state', request.state);
    location.searchParams.set('iss', c.issuer);
    res.redirect(302, location.href);
  });
  app.post('/token', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const clientId = String(req.body?.client_id ?? '');
    try {
      const resource = resourceParameter(c, req.body?.resource);
      let tokens;
      if (req.body?.grant_type === 'authorization_code') {
        const claims = await redeemAuthorizationCode(c, String(req.body?.code ?? ''), {
          codeVerifier: String(req.body?.code_verifier ?? ''), redirectUri: String(req.body?.redirect_uri ?? ''), clientId, resource });
        tokens = await issueTokens(c, { clientId, scope: claims.scope });
      } else if (req.body?.grant_type === 'refresh_token') {
        tokens = await rotateTokens(c, String(req.body?.refresh_token ?? ''), { clientId, resource });
      } else return oauthError(res, 400, 'unsupported_grant_type', 'Supported grants are authorization_code and refresh_token.');
      res.set('Cache-Control', 'no-store').json(tokens);
    } catch (error) {
      oauthError(res, 400, 'invalid_grant', safeError(error).message);
    }
  });
  app.post('/mcp', express.raw({ type: 'application/json', limit: '8mb' }), async (req, res) => {
    const grants = await verifyAccessToken(c, req.headers.authorization);
    if (!grants) {
      res.set('WWW-Authenticate', challenge);
      return oauthError(res, 401, 'unauthorized', 'A valid OAuth access token is required.');
    }
    if (!req.is('application/json')) return oauthError(res, 415, 'invalid_request', 'Use application/json.');
    if (inflight >= c.maxInflight) {
      res.set('Retry-After', '5');
      return oauthError(res, 429, 'slow_down', 'Too many proxied requests are in flight.');
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${c.upstreamToken}` };
    const protocolVersion = req.get('mcp-protocol-version');
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    inflight += 1;
    try {
      const upstream = await upstreamFetch(c.upstream.href, { method: 'POST', headers, body: req.body,
        redirect: 'error', signal: AbortSignal.timeout(c.upstreamTimeoutMs) });
      const contentType = upstream.headers.get('content-type') ?? '';
      res.status(upstream.status).set('Content-Type', /^(application\/json|text\/event-stream)/.test(contentType) ? contentType : 'application/json');
      if (upstream.status === 401) res.set('WWW-Authenticate', challenge);
      if (!upstream.body) { inflight -= 1; return res.end(); }
      res.once('close', () => { inflight -= 1; });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      inflight -= 1;
      if (res.headersSent) { res.destroy(); return; }
      oauthError(res, 502, 'upstream_unavailable', 'The MCP server could not be reached.');
    }
  });
  app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Only POST is proxied to the MCP server' }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid or oversized request' });
  });
  return app;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const c = gatewayConfig();
  const app = createGatewayApp(c);
  const server = app.listen(c.port, c.host, () => console.error('jovememory OAuth gateway started.'));
  // A proxied call may combine several upstream attempts, so the read window must exceed it.
  server.requestTimeout = c.upstreamTimeoutMs + 15000;
  server.headersTimeout = 10000;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
