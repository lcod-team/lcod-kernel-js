import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Registry, Context } from '../src/registry.js';
import { runCompose } from '../src/compose.js';
import { registerNodeCore } from '../src/core/index.js';
import { registerHttpContracts } from '../src/http/index.js';
import { registerTooling } from '../src/tooling/index.js';
import { flowIf } from '../src/flow/if.js';
import { flowForeach } from '../src/flow/foreach.js';
import { flowParallel } from '../src/flow/parallel.js';
import { flowTry } from '../src/flow/try.js';
import { flowThrow } from '../src/flow/throw.js';
import { flowBreak } from '../src/flow/break.js';
import { flowContinue } from '../src/flow/continue.js';

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('env/http_host serves routes from project/http_app', async () => {
  const registry = new Registry();
  registerNodeCore(registry);
  registerTooling(registry);
  registerHttpContracts(registry);
  registry.register('lcod://flow/if@1', flowIf);
  registry.register('lcod://flow/foreach@1', flowForeach);
  registry.register('lcod://flow/parallel@1', flowParallel);
  registry.register('lcod://flow/try@1', flowTry);
  registry.register('lcod://flow/throw@1', flowThrow);
  if (flowBreak) registry.register('lcod://flow/break@1', flowBreak);
  if (flowContinue) registry.register('lcod://flow/continue@1', flowContinue);

  const compose = [
    {
      call: 'lcod://env/http_host@0.1.0',
      in: {
        host: '127.0.0.1',
        port: 0,
        basePath: '/api'
      },
      slots: {
        projects: [
          {
            call: 'lcod://project/http_app@0.1.0',
            in: {
              name: 'catalog',
              basePath: '/catalog'
            },
            out: { project: '$' },
            slots: {
              sequences: [
                {
                  call: 'lcod://tooling/script@1',
                  in: {
                    source: "async () => ({ sequences: [{ id: 'catalog.list', handler: { type: 'script', source: `async () => ({ status: 200, body: [{ id: 1, name: 'Keyboard' }] })` } }] })"
                  },
                  out: { sequences: 'sequences' }
                }
              ],
              apis: [
                {
                  call: 'lcod://tooling/script@1',
                  in: {
                    source: "async () => ({ routes: [{ method: 'GET', path: '/items', sequenceId: 'catalog.list' }] })"
                  },
                  out: { routes: 'routes' }
                },
                {
                  call: 'lcod://flow/foreach@1',
                  in: { list: '$.routes' },
                  slots: {
                    body: [
                      {
                        call: 'lcod://http/api_route@0.1.0',
                        in: {
                          method: '$slot.item.method',
                          path: '$slot.item.path',
                          sequenceId: '$slot.item.sequenceId'
                        },
                        out: { route: 'route' }
                      }
                    ]
                  },
                  collectPath: '$.route',
                  out: { routes: 'results' }
                }
              ]
            }
          }
        ]
      },
      out: { host: '$' }
    }
  ];

  const ctx = new Context(registry);
  const result = await runCompose(ctx, compose, {});
  const host = result.host;
  assert.ok(host && host.server, 'host should expose server instance');
  assert.equal(typeof host.stop, 'function', 'host should expose stop() helper');
  assert.ok(Array.isArray(host.routes) && host.routes.length === 1, 'host should expose routes');
  assert.equal(host.routes[0].handlerId, 'catalog.list', 'route should surface handlerId');
  try {
    const response = await requestJson(`${host.url}/catalog/items`);
    assert.equal(response.status, 200);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed[0].name, 'Keyboard');
  } finally {
    await host.stop();
  }
});
