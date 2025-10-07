import http from 'node:http';
import { URL } from 'node:url';
import { Context } from '../registry.js';
import { runCompose } from '../compose.js';

function normalizeSegment(segment) {
  if (segment == null) return '';
  const str = String(segment);
  if (str === '') return '';
  if (str === '/') return '';
  return str.replace(/^\/+|\/+$/gu, '');
}

function joinPaths(...parts) {
  const segments = [];
  for (const part of parts) {
    const normalized = normalizeSegment(part);
    if (normalized) segments.push(normalized);
  }
  if (segments.length === 0) return '/';
  return `/${segments.join('/')}`;
}

function collectSlotResults(state, key) {
  if (!state) return [];
  const results = [];
  if (state[key]) results.push(state[key]);
  const plural = `${key}s`;
  if (Array.isArray(state[plural])) {
    for (const item of state[plural]) {
      if (item) results.push(item);
    }
  }
  return results;
}

async function executeHandler(registry, handlerDescriptor, requestContext, routeMeta) {
  if (!handlerDescriptor || typeof handlerDescriptor !== 'object') {
    throw new Error('Invalid handler descriptor');
  }
  const type = handlerDescriptor.type || 'script';
  const meta = { route: routeMeta, request: requestContext };
  if (type === 'script') {
    const source = handlerDescriptor.source;
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('Script handler must define a source');
    }
    const bindings = handlerDescriptor.bindings || {};
    const input = handlerDescriptor.input ?? { request: requestContext };
    const ctx = new Context(registry);
    return ctx.call('lcod://tooling/script@1', {
      source,
      bindings,
      input,
      meta
    });
  }
  if (type === 'component') {
    const target = handlerDescriptor.call || handlerDescriptor.component;
    if (typeof target !== 'string') {
      throw new Error('Component handler must provide call/component string');
    }
    const input = handlerDescriptor.input ?? { request: requestContext };
    const ctx = new Context(registry);
    return ctx.call(target, input, meta);
  }
  if (type === 'compose') {
    const steps = handlerDescriptor.compose;
    if (!Array.isArray(steps)) {
      throw new Error('Compose handler requires compose array');
    }
    const initial = {
      request: requestContext,
      ...(handlerDescriptor.initialState && typeof handlerDescriptor.initialState === 'object'
        ? handlerDescriptor.initialState
        : {})
    };
    const ctx = new Context(registry);
    return runCompose(ctx, steps, initial);
  }
  throw new Error(`Unsupported handler type: ${type}`);
}

export function registerHttpContracts(registry) {
  registry.register('lcod://http/api_route@0.1.0', async (_ctx, input = {}) => {
    if (!input.sequenceId) throw new Error('sequenceId is required for http/api_route');
    const method = (input.method || 'GET').toUpperCase();
    const path = joinPaths(input.path || '/');
    const route = {
      method,
      path,
      sequenceId: input.sequenceId,
      description: input.description,
    };
    if (Array.isArray(input.middlewares)) route.middlewares = [...input.middlewares];
    return { route };
  });

  registry.register('lcod://project/http_app@0.1.0', async (ctx, input = {}) => {
    if (!input.name) throw new Error('project/http_app requires name');
    const projectMeta = {
      name: input.name,
      basePath: joinPaths(input.basePath || '/'),
      metadata: input.metadata || {}
    };

    const seqState = await ctx.runSlot('sequences', { project: projectMeta }, { project: projectMeta });
    const sequences = Array.isArray(seqState?.sequences)
      ? seqState.sequences
      : collectSlotResults(seqState, 'sequence');

    const apiState = await ctx.runSlot('apis', { project: projectMeta, sequences }, { project: projectMeta, sequences });
    const routes = Array.isArray(apiState?.routes)
      ? apiState.routes
      : collectSlotResults(apiState, 'route');

    if (!Array.isArray(routes)) {
      throw new Error('project/http_app expected routes array from apis slot');
    }

    return {
      project: projectMeta,
      routes,
      sequences,
    };
  });

  registry.register('lcod://env/http_host@0.1.0', async (ctx, input = {}) => {
    const host = input.host || '0.0.0.0';
    const port = Number(input.port);
    if (!Number.isFinite(port)) throw new Error('env/http_host requires a numeric port');
    const basePath = (() => {
      const normalized = normalizeSegment(input.basePath || '');
      if (!normalized) return '';
      return `/${normalized}`;
    })();
    const metadata = input.metadata || {};

    const projectState = await ctx.runSlot('projects', {}, { host: { host, port, basePath, metadata } });
    const rawProjects = collectSlotResults(projectState, 'project');
    if (rawProjects.length === 0 && projectState && typeof projectState === 'object') {
      rawProjects.push(projectState);
    }

    const routeHandlers = new Map();
    const outputRoutes = [];
    const projectSummaries = [];

    for (const entry of rawProjects) {
      if (!entry) continue;
      const project = entry.project || entry;
      const routes = entry.routes || [];
      const sequences = entry.sequences || [];

      const seqMap = new Map();
      for (const seq of sequences) {
        if (seq && seq.id) seqMap.set(seq.id, seq);
      }

      const projectBase = joinPaths(basePath, project.basePath || '/');
      projectSummaries.push({ name: project.name, basePath: project.basePath, metadata: project.metadata });

      for (const route of routes) {
        if (!route || !route.sequenceId) continue;
        const method = (route.method || 'GET').toUpperCase();
        const fullPath = joinPaths(projectBase, route.path || '/');
        const key = `${method} ${fullPath}`;
        const sequence = seqMap.get(route.sequenceId);
        if (!sequence) {
          throw new Error(`Sequence not found for route ${route.sequenceId}`);
        }
        if (routeHandlers.has(key)) {
          throw new Error(`Duplicate route registered: ${key}`);
        }
        routeHandlers.set(key, {
          method,
          fullPath,
          project,
          route,
          sequence
        });
        const handlerId = sequence.id || route.sequenceId;
        outputRoutes.push({
          method,
          path: fullPath,
          handlerId,
          sequenceId: route.sequenceId,
          project: project.name
        });
      }
    }

    const server = http.createServer(async (req, res) => {
      try {
        const method = req.method?.toUpperCase() || 'GET';
        const parsed = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
        const pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
        const key = `${method} ${pathname}`;
        const entry = routeHandlers.get(key);
        if (!entry) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const rawBody = Buffer.concat(chunks);
        let parsedBody = rawBody.length ? rawBody : undefined;
        const contentType = req.headers['content-type'] || '';
        if (parsedBody && /^application\/json/u.test(contentType)) {
          try {
            parsedBody = JSON.parse(rawBody.toString('utf8'));
          } catch (_err) {
            // keep raw body if parse fails
          }
        }

        const addressInfo = server.address();
        const resolvedPort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;
        const requestContext = {
          method,
          path: pathname,
          url: parsed.pathname && parsed.search ? `${pathname}${parsed.search}` : pathname,
          query: Object.fromEntries(parsed.searchParams.entries()),
          headers: req.headers,
          body: parsedBody,
          rawBody: rawBody.length ? rawBody : undefined,
          host: {
            name: host,
            port: resolvedPort,
            basePath
          },
          project: entry.project,
          route: entry.route
        };

        const result = await executeHandler(
          ctx.registry,
          entry.sequence.handler,
          requestContext,
          { project: entry.project, route: entry.route }
        );
        const status = Number(result?.status) || 200;
        const headers = result?.headers && typeof result.headers === 'object'
          ? { ...result.headers }
          : { 'content-type': 'application/json' };
        const body = result?.body;

        res.writeHead(status, headers);
        if (body == null) {
          res.end();
        } else if (Buffer.isBuffer(body) || typeof body === 'string') {
          res.end(body);
        } else if (typeof body === 'object') {
          res.end(JSON.stringify(body));
        } else {
          res.end(String(body));
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    await new Promise((resolve, reject) => {
      server.listen(port, host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const publicHost = (host === '0.0.0.0' || host === '::') ? '127.0.0.1' : host;
    const baseUrl = `http://${publicHost}:${actualPort}`;
    const url = basePath && basePath !== '/' ? `${baseUrl}${basePath}` : baseUrl;

    let closingPromise = null;
    let closed = false;
    const stop = async () => {
      if (closed) {
        return closingPromise ?? Promise.resolve();
      }
      closingPromise = new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }).finally(() => {
        closed = true;
      });
      return closingPromise;
    };
    server.on('close', () => { closed = true; });

    return {
      url,
      routes: outputRoutes,
      projects: projectSummaries,
      server,
      stop
    };
  });
}
