/**
 * ErrorBoundary（v0.3.3 新增）：兜住渲染期异常，显示友好错误页而非整页白屏。
 *
 * 背景：此前任何渲染异常（包括 Rules of Hooks 违例触发的
 * "Rendered more/fewer hooks"）都会把整棵组件树打崩，用户只看到白屏、无任何提示。
 * 现在崩溃可见：展示错误信息 + 一键复制 + 重新加载；本地笔记文件不受影响。
 */
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  copied?: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 落到控制台便于 devtools 排查（生产包同样可见）
    console.error('Ivyea Note 渲染崩溃：', error, info.componentStack);
  }

  private copyDetail = async (): Promise<void> => {
    const text = this.detailText();
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      window.setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // 剪贴板不可用时静默：用户仍可在错误框内手动选中复制
    }
  };

  private detailText(): string {
    const e = this.state.error;
    if (!e) return '';
    return `${e.name}: ${e.message}${e.stack ? `\n\n${e.stack}` : ''}`;
  }

  render(): ReactNode {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="err-wrap">
        <div className="err-card">
          <h1>界面出了点问题</h1>
          <p>
            渲染发生错误，应用暂时无法继续显示。
            <br />
            你的笔记文件保存在本地，不受影响。可复制下方错误信息反馈，或重新加载。
          </p>
          <div className="err-detail">{this.detailText()}</div>
          <div className="err-actions">
            <button className="btn ghost" onClick={() => void this.copyDetail()}>
              {this.state.copied ? '已复制 ✓' : '复制错误信息'}
            </button>
            <button className="btn primary" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
