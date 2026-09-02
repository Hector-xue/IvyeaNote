import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, isInsecurePublic, defaultServerUrl } from './serverConn';

describe('normalizeServerUrl', () => {
  it('裸 IP 补 http', () => {
    expect(normalizeServerUrl('192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
    expect(normalizeServerUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
  it('localhost 补 http', () => {
    expect(normalizeServerUrl('localhost:8080')).toBe('http://localhost:8080');
  });
  it('内网段补 http', () => {
    expect(normalizeServerUrl('10.0.0.2')).toBe('http://10.0.0.2');
    expect(normalizeServerUrl('172.16.0.5:8080')).toBe('http://172.16.0.5:8080');
  });
  it('域名补 https', () => {
    expect(normalizeServerUrl('notes.example.com')).toBe('https://notes.example.com');
  });
  it('已有协议不动', () => {
    expect(normalizeServerUrl('http://a.com')).toBe('http://a.com');
    expect(normalizeServerUrl('https://a.com/')).toBe('https://a.com');
  });
  it('空串返回空', () => {
    expect(normalizeServerUrl('  ')).toBe('');
  });
});

describe('isInsecurePublic', () => {
  it('公网 http 为 true', () => {
    expect(isInsecurePublic('http://1.2.3.4:8080')).toBe(true);
    expect(isInsecurePublic('http://notes.example.com')).toBe(true);
  });
  it('局域网/localhost http 为 false', () => {
    expect(isInsecurePublic('http://192.168.1.5:8080')).toBe(false);
    expect(isInsecurePublic('http://127.0.0.1:8080')).toBe(false);
    expect(isInsecurePublic('http://10.0.0.2')).toBe(false);
  });
  it('https 永远 false', () => {
    expect(isInsecurePublic('https://notes.example.com')).toBe(false);
  });
});

describe('defaultServerUrl（v0.10.4：开源构建不许内置域名）', () => {
  /**
   * 这条是防复发的硬闸门。
   * v0.10.3 曾把作者自己的 note.ivyea.com 写死进 vite.config.ts，
   * 于是公开 Release 的每个安装包都在登录页底下显示别人的私有服务器地址。
   * 仓库默认构建（vitest 里没有任何 define）必须返回空串。
   */
  it('仓库默认构建没有任何预置服务器地址', () => {
    expect(defaultServerUrl()).toBe('');
  });

  it('返回值里绝不能出现具体域名', () => {
    expect(defaultServerUrl()).not.toMatch(/ivyea|\./);
  });
});
