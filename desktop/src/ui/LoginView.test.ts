import { describe, expect, it } from 'vitest';
import { parseAccountText } from './LoginView';

const VPS_SAMPLE = `Ivyea Note 登录信息（请妥善保管）
=============================================

服务器地址: https://note.example.com
账号: admin@example.com
密码: test-password-123

使用方法:
1) 打开 Ivyea Note 客户端`;

const LOCAL_SAMPLE = VPS_SAMPLE.replace('https://note.example.com', 'http://127.0.0.1:8080');

describe('parseAccountText（IvyeaNote-账号.txt 导入）', () => {
  it('解析 VPS 部署生成的账号文件', () => {
    expect(parseAccountText(VPS_SAMPLE)).toEqual({
      serverUrl: 'https://note.example.com',
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('解析本机部署生成的账号文件', () => {
    const r = parseAccountText(LOCAL_SAMPLE);
    expect(r.serverUrl).toBe('http://127.0.0.1:8080');
    expect(r.email).toBe('admin@example.com');
    expect(r.password).toBe('test-password-123');
  });

  it('兼容 Windows 换行(CRLF)', () => {
    const r = parseAccountText(LOCAL_SAMPLE.replace(/\n/g, '\r\n'));
    expect(r.serverUrl).toBe('http://127.0.0.1:8080');
  });

  it('密码含冒号时保留完整值', () => {
    const r = parseAccountText('服务器地址: http://x\n账号: a@b.c\n密码: ab:cd:ef');
    expect(r.password).toBe('ab:cd:ef');
  });

  it('无关文件返回空对象，不误填', () => {
    expect(parseAccountText('随便写的日记内容\n今天天气不错')).toEqual({});
  });
});
