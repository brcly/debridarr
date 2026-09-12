import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute } from 'node:path';
import { loadConfig } from '../src/config.js';
const required = { ADMIN_PASSWORD: 'test-password' };

test('deployment defaults require a password and ignore connection seeds', () => {
  assert.throws(() => loadConfig({}), /ADMIN_PASSWORD is required/);
  const config = loadConfig({ ...required, PROWLARR_URL: 'obsolete-invalid-value' });
  assert.equal(config.port, 7000);
  assert.equal(config.appUrl, 'http://localhost:7000');
  assert.equal(config.downloadDir, '/downloads');
  assert.ok(isAbsolute(config.dataDir));
  assert.equal(loadConfig({ ...required, PORT: '8080' }).appUrl, 'http://localhost:8080');
});

test('validates deployment settings without exposing their values', () => {
  for (const PORT of ['0', '-1', '65536', '1.5', '7e3', 'abc']) {
    assert.throws(() => loadConfig({ ...required, PORT }), /PORT must/);
  }
  for (const key of ['DOWNLOAD_DIR', 'DATA_DIR']) {
    assert.throws(() => loadConfig({ ...required, [key]: './relative' }), new RegExp(`${key} must`));
  }
  for (const APP_URL of ['invalid-secret', 'ftp://example.test', 'http://user:secret@example.test', 'http://example.test/path', 'http://example.test/?key=secret']) {
    assert.throws(() => loadConfig({ ...required, APP_URL }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /APP_URL must/);
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
  assert.equal(loadConfig({ ...required, APP_URL: 'https://example.test/' }).appUrl, 'https://example.test');
});

test('requires a bounded administrator password', () => {
  assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'short' }), /at least 12/);
  assert.throws(() => loadConfig({ ADMIN_PASSWORD: 'x'.repeat(1025) }), /at most 1024/);
  assert.equal(loadConfig({ ADMIN_PASSWORD: 'long-enough-password' }).adminPassword, 'long-enough-password');
});

test('LOG_LEVEL defaults to info and rejects unknown values', () => {
  assert.equal(loadConfig({ ...required }).logLevel, 'info');
  assert.equal(loadConfig({ ...required, LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.throws(() => loadConfig({ ...required, LOG_LEVEL: 'trace' }), /LOG_LEVEL must/);
});

test('playback wait budgets default sensibly and are operator-tunable', () => {
  const defaults = loadConfig({ ...required });
  assert.equal(defaults.metadataWaitMs, 8_000);
  assert.equal(defaults.bufferWaitMs, 120_000);
  const overridden = loadConfig({ ...required, DEBRIDARR_METADATA_WAIT_MS: '3000', DEBRIDARR_BUFFER_WAIT_MS: '60000' });
  assert.equal(overridden.metadataWaitMs, 3000);
  assert.equal(overridden.bufferWaitMs, 60000);
  for (const key of ['DEBRIDARR_METADATA_WAIT_MS', 'DEBRIDARR_BUFFER_WAIT_MS']) {
    for (const value of ['0', '-1', '1.5', 'abc']) {
      assert.throws(() => loadConfig({ ...required, [key]: value }), new RegExp(`${key} must`));
    }
  }
});
