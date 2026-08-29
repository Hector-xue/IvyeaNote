import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
// 样式分三层加载，顺序即优先级：
//   tokens    —— 唯一的尺寸/颜色来源
//   index     —— 历史累加的组件样式（按 v0.x 分区，逐步往上面两层迁）
//   surface   —— 平面层次/滚动条/控件/焦点/动效
//   typography—— 编辑态与阅读态共用的文字规则，必须最后加载才压得住历史规则
import './styles/tokens.css';
import './index.css';
import './styles/surface.css';
import './styles/typography.css';

// 不用 StrictMode：避免开发模式双挂载导致重复同步/WS 连接，行为更接近生产
// ErrorBoundary（v0.3.3）：渲染异常时显示友好错误页，不再整页白屏
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
