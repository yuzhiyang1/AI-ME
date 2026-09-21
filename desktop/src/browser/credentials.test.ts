import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserCredentials } from './credentials.js';

test('凭据按会话/站点绑定；嵌套输出及 JSON 特殊字符不泄漏', () => {
  const vault = new BrowserCredentials();
  const value = 'transient-"-\\-测试';
  vault.save('one', { name: 'test-password', origin: 'https://example.com/login', value });
  assert.equal(vault.resolve('one', 'test-password', 'https://example.com'), value);
  assert.throws(() => vault.resolve('two', 'test-password', 'https://example.com'));
  assert.throws(() => vault.resolve('one', 'test-password', 'https://other.example'));
  assert.deepEqual(vault.redact('one', { nested: [value, `before ${value} after`] }), { nested: ['[已隐藏凭据]', 'before [已隐藏凭据] after'] });
  vault.clear('one');
  assert.throws(() => vault.resolve('one', 'test-password', 'https://example.com'));
});
