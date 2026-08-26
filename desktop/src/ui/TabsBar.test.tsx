// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { TabsBar, tabLabel } from './TabsBar';

afterEach(() => cleanup());

describe('tabLabel', () => {
  it('取 basename 并隐藏后缀', () => {
    expect(tabLabel('notes/文章/标题.md')).toBe('标题');
    expect(tabLabel('x.markdown')).toBe('x');
  });
});

describe('TabsBar 交互', () => {
  function Harness() {
    const [active, setActive] = useState<string | null>('a.md');
    const [tabs, setTabs] = useState<string[]>(['a.md', 'sub/b.md']);
    return (
      <TabsBar
        tabs={tabs}
        active={active}
        onSelect={setActive}
        onClose={(p) => {
          setTabs((ts) => {
            const next = ts.filter((t) => t !== p);
            if (active === p) setActive(next[0] ?? null);
            return next;
          });
        }}
      />
    );
  }

  it('渲染标签并隐藏后缀，当前标签高亮', () => {
    render(<Harness />);
    const a = screen.getByText('a');
    expect(a).toBeTruthy();
    expect(a.closest('.tab')?.className).toContain('active');
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('点击标签切换 active', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('b'));
    expect(screen.getByText('b').closest('.tab')?.className).toContain('active');
    expect(screen.getByText('a').closest('.tab')?.className).not.toContain('active');
  });

  it('关闭标签后从列表移除，active 回退', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('关闭 b'));
    expect(screen.queryByText('b')).toBeNull();
    expect(screen.getByText('a').closest('.tab')?.className).toContain('active');
  });

  it('空标签列表不渲染', () => {
    const { container } = render(<TabsBar tabs={[]} active={null} onSelect={() => undefined} onClose={() => undefined} />);
    expect(container.querySelector('.tabs-bar')).toBeNull();
  });
});
