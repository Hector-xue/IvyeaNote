/**
 * `apiBase` —— 服务器地址补全。
 *
 * 这条曾经是个从 v0.2.0 潜伏至今的 P0：构造函数硬性要求地址以 `/api/v1` 结尾，
 * 而安装脚本、登录框占位符、`probeServer` 全是裸地址口径，于是任何按文档
 * 填地址的用户，登录成功之后应用立刻被 ErrorBoundary 接住变成错误页。
 *
 * 单测没抓住它是因为同步那 17 条一致性用例都拿已经正确的 baseUrl 直接构造
 * client，绕开了登录那一段。所以这里除了正常用例，特意钉住「裸地址必须能用」。
 */
import { describe, expect, it } from 'vitest';
import { apiBase } from './api';

describe('apiBase', () => {
  it('裸地址补上 /api/v1 —— 安装脚本和登录框教用户填的就是这个', () => {
    expect(apiBase('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/api/v1');
    expect(apiBase('https://note.example.com')).toBe('https://note.example.com/api/v1');
  });

  it('已经带 /api/v1 的不会补第二遍（老配置照样能用）', () => {
    expect(apiBase('https://note.example.com/api/v1')).toBe('https://note.example.com/api/v1');
  });

  it('结尾斜杠不影响结果', () => {
    expect(apiBase('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/api/v1');
    expect(apiBase('https://x.com/api/v1/')).toBe('https://x.com/api/v1');
    expect(apiBase('http://127.0.0.1:8080///')).toBe('http://127.0.0.1:8080/api/v1');
  });

  it('前后空白被忽略——复制粘贴很容易带上', () => {
    expect(apiBase('  http://127.0.0.1:8080  ')).toBe('http://127.0.0.1:8080/api/v1');
  });

  it('带子路径的反代也照样补在最后', () => {
    expect(apiBase('https://x.com/note')).toBe('https://x.com/note/api/v1');
  });

  it('幂等：补过一次再补不会变', () => {
    const once = apiBase('http://127.0.0.1:8080');
    expect(apiBase(once)).toBe(once);
  });
});
