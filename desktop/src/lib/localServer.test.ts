// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { localCred } from './localServer';

beforeEach(() => localStorage.clear());

describe('localCred（内置服务端的本机凭据）', () => {
  /**
   * 这条是数据安全条款，不是风格问题：凭据换一组就等于换了个账号，
   * 之前存在服务端 SQLite 里的笔记就再也对不上了。
   */
  it('生成一次之后必须一直复用', () => {
    const a = localCred();
    const b = localCred();
    expect(b).toEqual(a);
  });

  it('落盘到 localStorage，重启进程也还是同一组', () => {
    const a = localCred();
    const raw = localStorage.getItem('ivnote.localServer.cred');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(a);
  });

  it('不同机器（不同存储）生成的不是同一组——不是"所有人共用一个默认密码"', () => {
    const a = localCred();
    localStorage.clear();
    const b = localCred();
    expect(b.password).not.toBe(a.password);
    expect(b.email).not.toBe(a.email);
  });

  it('密码有足够长度，邮箱是 .local 不会被当成真实邮箱', () => {
    const c = localCred();
    expect(c.password.length).toBeGreaterThanOrEqual(20);
    expect(c.email).toMatch(/@ivnote\.local$/);
  });

  it('存储里是坏数据时重新生成而不是抛异常', () => {
    localStorage.setItem('ivnote.localServer.cred', '{不是 JSON');
    const c = localCred();
    expect(c.email).toMatch(/@ivnote\.local$/);
    expect(c.password.length).toBeGreaterThanOrEqual(20);
  });
});
