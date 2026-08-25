// @vitest-environment jsdom
/**
 * R4 回归：渲染异常时显示友好错误页，而不是整页白屏。
 */
import { Component, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

class Bomb extends Component {
  render(): ReactNode {
    throw new Error('boom-test');
  }
}

describe('ErrorBoundary（R4：崩溃可见，不再白屏）', () => {
  it('子组件渲染抛错 → 显示错误页（含错误信息与重载按钮）', () => {
    // 屏蔽 React 自带的错误日志噪音
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText('界面出了点问题')).toBeTruthy();
    expect(screen.getByText(/boom-test/)).toBeTruthy();
    expect(screen.getByText('重新加载')).toBeTruthy();
    expect(screen.getByText('复制错误信息')).toBeTruthy();
    errSpy.mockRestore();
  });

  it('子组件正常时原样渲染，不插入额外节点', () => {
    const { container } = render(
      <ErrorBoundary>
        <div className="ok-child">hello</div>
      </ErrorBoundary>
    );
    expect(container.querySelector('.ok-child')).toBeTruthy();
    expect(container.querySelector('.err-wrap')).toBeNull();
  });
});
