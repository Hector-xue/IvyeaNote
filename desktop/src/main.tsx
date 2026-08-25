import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './index.css';

// 不用 StrictMode：避免开发模式双挂载导致重复同步/WS 连接，行为更接近生产
// ErrorBoundary（v0.3.3）：渲染异常时显示友好错误页，不再整页白屏
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
