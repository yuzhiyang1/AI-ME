// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserCredentials } from './BrowserCredentials.jsx';

afterEach(cleanup);

it('凭据经当前会话 IPC 保存，成功后清空明文，不把秘密放进状态提示', async () => {
  const browser = { credential: vi.fn().mockResolvedValue({ name: 'test-password', origin: 'https://example.com' }) };
  render(<BrowserCredentials browser={browser} sessionId="s1" url="https://example.com/login" />);
  fireEvent.change(screen.getByLabelText('凭据内容'), { target: { value: 'ephemeral-test-value' } });
  fireEvent.click(screen.getByRole('button', { name: '保存临时凭据', hidden: true }));
  await waitFor(() => expect(screen.getByLabelText('凭据内容').value).toBe(''));
  expect(browser.credential).toHaveBeenCalledWith('s1', { name: 'test-password', origin: 'https://example.com/login', value: 'ephemeral-test-value' });
  expect(screen.getByRole('status', { hidden: true }).textContent).not.toContain('ephemeral-test-value');
});

it('清除只针对当前会话，不触碰 Jev 配置', async () => {
  const browser = { credential: vi.fn().mockResolvedValue({ cleared: true }) };
  render(<BrowserCredentials browser={browser} sessionId="s2" url="" />);
  fireEvent.click(screen.getByRole('button', { name: '清除全部', hidden: true }));
  await waitFor(() => expect(browser.credential).toHaveBeenCalledWith('s2', { clear: true }));
});
