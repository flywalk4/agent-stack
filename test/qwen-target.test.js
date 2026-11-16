import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = pathToFileURL(path.join(root, 'src', 'targets', 'qwen.js')).href;

const settings = {
  modelProviders: {
    openai: [
      { id: 'one', baseUrl: 'https://one.example.com/v1', generationConfig: { extra_body: { a: 1 } } },
      { id: 'two', baseUrl: 'https://two.example.com/v1', generationConfig: { customHeaders: { 'X-Keep': 'yes' } } },
      { id: 'default-url' },
    ],
  },
  model: { name: 'one', baseUrl: 'https://one.example.com/v1' },
  providers: { untouched: { baseUrl: 'https://untouched.example.com/v1' } },
};

test('Qwen target routes every configured model through bili and headroom', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stack-qwen-'));
  try {
    const file = path.join(home, '.qwen', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);

    const script = `
      import qwen from ${JSON.stringify(target)};
      qwen.apply();
      qwen.apply();
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home },
      stdio: 'pipe',
    });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const chain = 'http://127.0.0.1:18788/bili/http://127.0.0.1:8787/v1';
    const [one, two, noUrl] = after.modelProviders.openai;

    assert.equal(one.baseUrl, chain);
    assert.equal(one.generationConfig.customHeaders['x-headroom-base-url'], 'https://one.example.com/v1');
    assert.deepEqual(one.generationConfig.extra_body, { a: 1 });

    assert.equal(two.baseUrl, chain);
    assert.equal(two.generationConfig.customHeaders['X-Keep'], 'yes');
    assert.equal(two.generationConfig.customHeaders['x-headroom-base-url'], 'https://two.example.com/v1');

    // A route without a baseUrl uses the provider default; it is left alone.
    assert.equal(noUrl.baseUrl, undefined);
    assert.equal(noUrl.generationConfig, undefined);

    assert.equal(after.model.baseUrl, chain);
    assert.equal(after.model.generationConfig.customHeaders['x-headroom-base-url'], 'https://one.example.com/v1');

    // Re-running must not wrap the chain URL again.
    assert.equal((after.model.baseUrl.match(/http/g) ?? []).length, 2);
    assert.equal(after.providers.untouched.baseUrl, 'https://untouched.example.com/v1');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Qwen custom providers get a dedicated headroom upstream', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stack-qwen-prov-'));
  try {
    const file = path.join(home, '.qwen', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      model: { name: 'prov/auto', baseUrl: 'https://prov.example.com/v1' },
      providers: { prov: { baseUrl: 'https://prov.example.com/v1', models: [{ model: 'auto' }] } },
    }, null, 2)}\n`);

    const script = `
      import qwen, { qwenHeadroomUpstream } from ${JSON.stringify(target)};
      qwen.apply();
      qwen.apply();
      console.log(qwenHeadroomUpstream());
      console.log(qwen.ok());
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    }).trim().split('\n');

    assert.equal(out[0], 'https://prov.example.com/v1');
    assert.equal(out[1], 'true');

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.providers.prov.baseUrl, 'http://127.0.0.1:18788/bili/http://127.0.0.1:8789/v1');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
