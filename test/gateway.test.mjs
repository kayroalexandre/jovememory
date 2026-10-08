import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gatewayConfig } from '../src/gateway-config.mjs';
import { authorizationServerMetadata, createClientRegistry, createRateLimiter, hashPassword, issueLoginTicket,
  pkceChallenge, protectedResourceMetadata, redeemLoginTicket, verifyAccessToken, verifyPassword } from '../src/gateway-oauth.mjs';
import { createGatewayApp } from '../src/gateway.mjs';

const PASSWORD = 'synthetic-operator-password';
const verifier = () => randomBytes(48).toString('base64url');
const baseEnv = async () => ({
  NODE_ENV: 'development',
  PUBLIC_URL: 'http://127.0.0.1:3100',
  UPSTREAM_MCP_URL: 'http://127.0.0.1:3007/mcp',
  UPSTREAM_BEARER_TOKEN: randomBytes(32).toString('base64url'),
  OAUTH_SIGNING_KEY: randomBytes(32).toString('hex'),
  OPERATOR_PASSWORD_HASH: await hashPassword(PASSWORD)
});
async function startGateway(overrides = {}, deps = {}) {
  const c = gatewayConfig({ ...(await baseEnv()), ...overrides });
  const seen = { requests: [], documents: new Map() };
  const upstream = deps.upstream ?? (async () => new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
    { status: 200, headers: { 'content-type': 'application/json' } }));
  const fetchImpl = async (url, options) => { seen.requests.push({ url: String(url), options }); return upstream(String(url), options); };
  const registry = deps.clientRegistry ?? createClientRegistry({
    fetchImpl: async url => new Response(JSON.stringify({ client_name: 'Synthetic Client', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }),
      { status: 200, headers: { 'content-type': 'application/json' } }),
    lookup: async () => [{ address: '203.0.113.10' }] });
  const server = createGatewayApp(c, { ...deps, fetch: fetchImpl, clientRegistry: registry }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { c, seen, origin, close: () => new Promise(resolve => server.close(resolve)) };
}
const form = body => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
async function authorizeQuery(overrides = {}) {
  return new URLSearchParams({ response_type: 'code', client_id: 'https://chatgpt.com/oauth/client.json',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: pkceChallenge(overrides.verifier ?? 'v'.repeat(64)),
    code_challenge_method: 'S256', state: 'synthetic-state', scope: 'memory:read', resource: 'http://127.0.0.1:3100', ...overrides.query });
}
async function login(origin, overrides = {}) {
  const codeVerifier = overrides.verifier ?? randomBytes(48).toString('base64url');
  const query = await authorizeQuery({ verifier: codeVerifier, ...overrides });
  const page = await fetch(`${origin}/authorize?${query}`);
  const ticket = /name="ticket" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!ticket) return { page, ticket: null };
  const response = await fetch(`${origin}/authorize`, form({ ticket, password: overrides.password ?? PASSWORD }));
  return { page, ticket, response, codeVerifier, location: response.headers.get('location') };
}

test('Gateway configuration fails closed without private credentials and refuses unsafe upstreams',async()=>{
  const env = await baseEnv();
  assert.equal(gatewayConfig(env).issuer, 'http://127.0.0.1:3100');
  for (const key of ['UPSTREAM_BEARER_TOKEN', 'OAUTH_SIGNING_KEY', 'OPERATOR_PASSWORD_HASH'])
    assert.throws(() => gatewayConfig({ ...env, [key]: '' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, OAUTH_SIGNING_KEY: 'not-hex' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, UPSTREAM_BEARER_TOKEN: 'short' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, PUBLIC_URL: 'https://host.example.com/mcp' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, UPSTREAM_MCP_URL: 'https://upstream.example.com/tools' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, UPSTREAM_MCP_URL: 'http://upstream.example.com/mcp' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, NODE_ENV: 'production', PUBLIC_URL: 'http://127.0.0.1:3100' }), { code: 'CONFIG' });
  assert.throws(() => gatewayConfig({ ...env, ACCESS_TOKEN_TTL_SECONDS: '10' }), { code: 'CONFIG' });
  const clients = gatewayConfig({ ...env, STATIC_OAUTH_CLIENTS: JSON.stringify([{ client_id: 'synthetic-client', client_name: 'Synthetic Client', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }]) });
  assert.deepEqual(clients.staticClients[0].redirectUris, ['https://chatgpt.com/connector_platform_oauth_redirect']);
  assert.throws(() => gatewayConfig({ ...env, STATIC_OAUTH_CLIENTS: '[{"client_id":"x","redirect_uris":["http://insecure.example.com/cb"]}]' }), { code: 'CONFIG' });
});
test('OAuth metadata publishes the resource, the issuer and the fields ChatGPT requires',async()=>{
  const c = gatewayConfig(await baseEnv());
  const prmd = protectedResourceMetadata(c);
  assert.equal(prmd.resource, c.issuer);
  assert.deepEqual(prmd.authorization_servers, [c.issuer]);
  assert.deepEqual(prmd.scopes_supported, ['memory:read']);
  const as = authorizationServerMetadata(c);
  assert.equal(as.issuer, c.issuer);
  assert.equal(as.authorization_endpoint, `${c.issuer}/authorize`);
  assert.equal(as.token_endpoint, `${c.issuer}/token`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.equal(as.revocation_endpoint, undefined);
});
test('Served metadata and the unauthenticated challenge are the ones a client can follow',async()=>{
  const gateway = await startGateway();
  try {
    const prmd = await (await fetch(`${gateway.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prmd.resource, gateway.c.issuer);
    const as = await (await fetch(`${gateway.origin}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, gateway.c.issuer);
    const anonymous = await fetch(`${gateway.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:3100\/\.well-known\/oauth-protected-resource"/);
    assert.match(anonymous.headers.get('www-authenticate'), /scope="memory:read"/);
    assert.equal((await fetch(`${gateway.origin}/health`)).status, 200);
    assert.equal((await fetch(`${gateway.origin}/mcp`)).status, 405);
    assert.equal((await fetch(`${gateway.origin}/unknown`)).status, 404);
  } finally { await gateway.close(); }
});
test('Operator passwords are scrypt hashed, constant-time compared and rejected when malformed',async()=>{
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword(stored, PASSWORD), true);
  assert.equal(await verifyPassword(stored, 'synthetic-operator-passwore'), false);
  assert.equal(await verifyPassword(stored, ''), false);
  assert.equal(await verifyPassword('garbage', PASSWORD), false);
  assert.equal(await verifyPassword('', PASSWORD), false);
  assert.notEqual(await hashPassword(PASSWORD), stored);
  await assert.rejects(hashPassword('short'), { code: 'INPUT' });
});
test('PKCE challenges are S256 and a mismatched verifier cannot redeem the code',async()=>{
  assert.match(pkceChallenge('v'.repeat(64)), /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => pkceChallenge('too-short'), { code: 'OAUTH' });
  const gateway = await startGateway();
  try {
    const authorized = await login(gateway.origin);
    assert.equal(authorized.response.status, 302);
    assert.equal(new URL(authorized.location).searchParams.get('state'), 'synthetic-state');
    assert.equal(new URL(authorized.location).searchParams.get('iss'), gateway.c.issuer);
    const code = new URL(authorized.location).searchParams.get('code');
    const exchange = await fetch(`${gateway.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code, code_verifier: randomBytes(48).toString('base64url'), redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: gateway.c.issuer }));
    assert.equal(exchange.status, 400);
    assert.equal((await exchange.json()).error, 'invalid_grant');
  } finally { await gateway.close(); }
});
test('Authorization code exchange issues tokens bound to the client, resource, scope and PKCE challenge',async()=>{
  const gateway = await startGateway();
  try {
    const authorized = await login(gateway.origin);
    const code = new URL(authorized.location).searchParams.get('code');
    const tokens = await (await fetch(`${gateway.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code, code_verifier: authorized.codeVerifier, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: gateway.c.issuer }))).json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.equal(tokens.scope, 'memory:read');
    assert.equal(tokens.expires_in, gateway.c.accessTtlSeconds);
    const grants = await verifyAccessToken(gateway.c, `Bearer ${tokens.access_token}`);
    assert.equal(grants.scope, 'memory:read');
    assert.equal(grants.clientId, 'https://chatgpt.com/oauth/client.json');
    assert.equal(await verifyAccessToken(gateway.c, `Bearer ${tokens.refresh_token}`), null);
    assert.equal(await verifyAccessToken(gateway.c, `Bearer ${tokens.access_token}x`), null);
    assert.equal(await verifyAccessToken(gateway.c, 'Basic abc'), null);
    const refreshed = await (await fetch(`${gateway.origin}/token`, form({ grant_type: 'refresh_token', client_id: 'https://chatgpt.com/oauth/client.json',
      refresh_token: tokens.refresh_token, resource: gateway.c.issuer }))).json();
    assert.equal(refreshed.scope, 'memory:read');
    assert.notEqual(refreshed.access_token, tokens.access_token);
    const foreign = await fetch(`${gateway.origin}/token`, form({ grant_type: 'refresh_token', client_id: 'https://other.example.com/client',
      refresh_token: tokens.refresh_token, resource: gateway.c.issuer }));
    assert.equal(foreign.status, 400);
    const otherResource = await fetch(`${gateway.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code, code_verifier: authorized.codeVerifier, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: 'https://elsewhere.example.com' }));
    assert.equal(otherResource.status, 400);
  } finally { await gateway.close(); }
});
test('Authorization requests require PKCE, state and a registered client, and never leak the password',async()=>{
  const gateway = await startGateway();
  try {
    const page = await (await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { code_challenge_method: 'plain' } })}`)).text();
    assert.match(page, /S256 code challenge method is supported/);
    assert.match(page, /Start again from the ChatGPT connector page/);
    assert.equal((await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { state: '' } })}`)).status, 400);
    assert.equal((await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { scope: 'memory:write' } })}`)).status, 400);
    assert.equal((await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { redirect_uri: 'https://attacker.example.com/cb' } })}`)).status, 400);
    assert.equal((await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { resource: 'https://elsewhere.example.com' } })}`)).status, 400);
    assert.equal((await fetch(`${gateway.origin}/authorize?${await authorizeQuery({ query: { client_id: 'synthetic-unregistered' } })}`)).status, 400);
    const rejected = await login(gateway.origin, { password: 'wrong-operator-password' });
    assert.equal(rejected.response.status, 401);
    assert.match(await rejected.response.text(), /Authentication failed/);
    assert.equal(rejected.response.headers.get('location'), null);
    assert.equal((await fetch(`${gateway.origin}/authorize`, form({ ticket: 'forged.ticket.value', password: PASSWORD }))).status, 400);
    assert.equal((await fetch(`${gateway.origin}/authorize`, form({ ticket: 'x', password: 'y'.repeat(40) }))).status, 400);
    const served = await (await fetch(`${gateway.origin}/authorize?${await authorizeQuery()}`)).text();
    assert.equal(served.includes(gateway.c.upstreamToken), false);
    assert.equal(served.includes(PASSWORD), false);
    assert.match(served, /Synthetic Client/);
  } finally { await gateway.close(); }
});
test('Login throttling blocks repeated failures and forgets the key after success',async()=>{
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000 });
  assert.equal(limiter.attempt('a').allowed, true);
  assert.equal(limiter.attempt('a').allowed, true);
  const blocked = limiter.attempt('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
  assert.equal(limiter.attempt('b').allowed, true);
  limiter.forget('a');
  assert.equal(limiter.attempt('a').allowed, true);
});
test('Client registration accepts static clients and CIMD documents and refuses everything else',async()=>{
  const c = gatewayConfig({ ...(await baseEnv()), STATIC_OAUTH_CLIENTS: JSON.stringify([{ client_id: 'synthetic-client', client_name: 'Static Client', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }]) });
  const document = { client_name: 'CIMD Client', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] };
  const registry = createClientRegistry({
    fetchImpl: async url => new Response(JSON.stringify(document), { status: 200 }),
    lookup: async () => [{ address: '203.0.113.10' }] });
  assert.deepEqual(await registry(c, 'synthetic-client', 'https://chatgpt.com/connector_platform_oauth_redirect'), { clientId: 'synthetic-client', clientName: 'Static Client', source: 'static' });
  await assert.rejects(registry(c, 'synthetic-client', 'https://attacker.example.com/cb'), { code: 'OAUTH' });
  assert.equal((await registry(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect')).source, 'cimd');
  await assert.rejects(registry(c, 'https://chatgpt.com/oauth/client.json', 'https://attacker.example.com/cb'), { code: 'OAUTH' });
  await assert.rejects(registry(c, 'not-a-url', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  await assert.rejects(registry(c, 'https://chatgpt.com/oauth/client.json?tenant=1', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const privateHost = createClientRegistry({ fetchImpl: async () => new Response('{}'), lookup: async () => [{ address: '127.0.0.1' }] });
  await assert.rejects(privateHost(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const unresolvable = createClientRegistry({ fetchImpl: async () => new Response('{}'), lookup: async () => { throw new Error('dns'); } });
  await assert.rejects(unresolvable(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const missing = createClientRegistry({ fetchImpl: async () => new Response('not json', { status: 200 }), lookup: async () => [{ address: '203.0.113.10' }] });
  await assert.rejects(missing(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const oversized = createClientRegistry({ fetchImpl: async () => new Response(JSON.stringify({ redirect_uris: ['x'.repeat(200000)] }), { status: 200 }), lookup: async () => [{ address: '203.0.113.10' }] });
  await assert.rejects(oversized(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const failing = createClientRegistry({ fetchImpl: async () => new Response('', { status: 500 }), lookup: async () => [{ address: '203.0.113.10' }] });
  await assert.rejects(failing(c, 'https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/connector_platform_oauth_redirect'), { code: 'OAUTH' });
  const local = createClientRegistry({ fetchImpl: async () => new Response('{}'), lookup: async () => [{ address: '203.0.113.10' }] });
  assert.ok(await local(c, 'https://chatgpt.com/oauth/client.json', 'http://127.0.0.1/callback'));
  await assert.rejects(local(c, 'https://chatgpt.com/oauth/client.json', 'http://localhost/callback'), { code: 'OAUTH' });
});
test('Proxied MCP calls carry the upstream profile token and never the client credential',async()=>{
  const gateway = await startGateway({}, { upstream: async () => new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  try {
    const authorized = await login(gateway.origin);
    const tokens = await (await fetch(`${gateway.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code: new URL(authorized.location).searchParams.get('code'), code_verifier: authorized.codeVerifier,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: gateway.c.issuer }))).json();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const call = await fetch(`${gateway.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}`, 'mcp-protocol-version': '2025-11-25' }, body });
    assert.equal(call.status, 200);
    assert.deepEqual(await call.json(), { jsonrpc: '2.0', id: 1, result: { tools: [] } });
    assert.equal(gateway.seen.requests.length, 1);
    const forwarded = gateway.seen.requests[0];
    assert.equal(forwarded.url, gateway.c.upstream.href);
    assert.equal(forwarded.options.headers.authorization, `Bearer ${gateway.c.upstreamToken}`);
    assert.equal(forwarded.options.headers['mcp-protocol-version'], '2025-11-25');
    assert.equal(forwarded.options.body.toString(), body);
    const unsupported = await fetch(`${gateway.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${tokens.access_token}` }, body: body });
    assert.equal(unsupported.status, 415);
    assert.equal(gateway.seen.requests.length, 1);
  } finally { await gateway.close(); }
});
test('Proxied failures stay declared: upstream errors pass through and transport faults become 502',async()=>{
  const gateway = await startGateway({}, { upstream: async () => new Response('{"error":"Authentication required"}', { status: 401, headers: { 'content-type': 'application/json' } }) });
  try {
    const authorized = await login(gateway.origin);
    const tokens = await (await fetch(`${gateway.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code: new URL(authorized.location).searchParams.get('code'), code_verifier: authorized.codeVerifier,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: gateway.c.issuer }))).json();
    const refused = await fetch(`${gateway.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: '{}' });
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('www-authenticate'), /resource_metadata=/);
  } finally { await gateway.close(); }
  const broken = await startGateway({}, { upstream: async () => { throw new Error('synthetic transport fault'); } });
  try {
    const authorized = await login(broken.origin);
    const tokens = await (await fetch(`${broken.origin}/token`, form({ grant_type: 'authorization_code', client_id: 'https://chatgpt.com/oauth/client.json',
      code: new URL(authorized.location).searchParams.get('code'), code_verifier: authorized.codeVerifier,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', resource: broken.c.issuer }))).json();
    const failed = await fetch(`${broken.origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: '{}' });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, 'upstream_unavailable');
  } finally { await broken.close(); }
});
test('Unknown hosts and foreign origins are refused before any OAuth or proxy work',async()=>{
  const gateway = await startGateway();
  try {
    const foreign = await fetch(`${gateway.origin}/authorize?${await authorizeQuery()}`, { headers: { host: 'attacker.example.com' } });
    assert.equal(foreign.status, 403);
    const origin = await fetch(`${gateway.origin}/.well-known/oauth-protected-resource`, { headers: { origin: 'https://attacker.example.com' } });
    assert.equal(origin.status, 403);
    assert.equal((await fetch(`${gateway.origin}/.well-known/oauth-protected-resource`, { headers: { origin: gateway.c.issuer } })).status, 200);
    assert.equal(gateway.seen.requests.length, 0);
  } finally { await gateway.close(); }
});
test('Login tickets are signed, short lived and bound to the authorization request',async()=>{
  const c = gatewayConfig(await baseEnv());
  const request = { clientId: 'https://chatgpt.com/oauth/client.json', redirectUri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    codeChallenge: pkceChallenge('v'.repeat(64)), state: 'synthetic-state', scope: 'memory:read', resource: c.issuer };
  const ticket = await issueLoginTicket(c, request);
  assert.deepEqual(await redeemLoginTicket(c, ticket), request);
  await assert.rejects(redeemLoginTicket(c, `${ticket}x`), { code: 'OAUTH' });
  await assert.rejects(redeemLoginTicket(c, 'forged'), { code: 'OAUTH' });
  const other = gatewayConfig({ ...(await baseEnv()), OAUTH_SIGNING_KEY: randomBytes(32).toString('hex') });
  await assert.rejects(redeemLoginTicket(other, ticket), { code: 'OAUTH' });
  assert.equal(await verifyPassword(c.passwordHash, PASSWORD), true);
});
