import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// 不用 StrictMode：避免开发模式双挂载导致重复同步/WS 连接，行为更接近生产
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
