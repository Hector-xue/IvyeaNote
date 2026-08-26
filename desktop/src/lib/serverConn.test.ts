import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, isInsecurePublic } from './serverConn';

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
