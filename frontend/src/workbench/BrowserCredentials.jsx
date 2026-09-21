import { useState } from 'react';
import { Button } from '../../vendor/zcode/packages/ui/src/components/ui/button.tsx';
import { Input } from '../../vendor/zcode/packages/ui/src/components/ui/input.tsx';

/** 联调凭据通过受限 IPC 送入本次会话内存，输入完成立即清空组件中的明文。 */
export function BrowserCredentials({ browser, sessionId, url }) {
  const [name, setName] = useState('test-password');
  const [origin, setOrigin] = useState('');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  if (!browser.credential) return null;
  return <details data-testid="browser-credentials" className="rounded-lg border border-border p-2">
    <summary className="cursor-pointer font-medium">本次会话的联调凭据</summary>
    <p className="my-2 text-xs text-muted-foreground">账号或密码在这里填写，聊天只提供名称。仅当前会话、指定站点可用；关闭浏览器或退出应用后清除，不保存到 Git 或模型记录。</p>
    <form className="space-y-2" onSubmit={async event => {
      event.preventDefault();
      if (saving) return;
      setSaving(true);
      setMessage('');
      try {
        const result = await browser.credential(sessionId, { name, origin: origin || url, value });
        setValue('');
        setMessage(`已保存引用 ${result.name}，站点 ${result.origin}。在聊天中告诉 AI 使用这个凭据名称。`);
      } catch (error) { setMessage(error.message); }
      finally { setSaving(false); }
    }}>
      <Input aria-label="凭据名称" value={name} onChange={event => setName(event.target.value)} placeholder="例如 test-password" disabled={saving} />
      <Input aria-label="凭据站点" value={origin} onChange={event => setOrigin(event.target.value)} placeholder={url || 'https://测试站点'} disabled={saving} />
      <Input aria-label="凭据内容" type="password" autoComplete="off" value={value} onChange={event => setValue(event.target.value)} disabled={saving} />
      <div className="flex gap-2"><Button type="submit" disabled={saving || !value || !(origin || url)}>保存临时凭据</Button>
        <Button type="button" variant="outline" disabled={saving} onClick={async () => {
          try { await browser.credential(sessionId, { clear: true }); setValue(''); setMessage('本次会话凭据已清除'); }
          catch (error) { setMessage(error.message); }
        }}>清除全部</Button></div>
      {message && <p role="status" className="break-words text-xs">{message}</p>}
    </form>
  </details>;
}
