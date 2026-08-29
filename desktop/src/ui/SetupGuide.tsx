import { useState } from 'react';
import logoUrl from '../assets/logo.png';

interface Props {
  onBack: () => void;
}

/**
 * 部署引导：讲清「服务器地址填什么」「账号密码从哪来」。
 * 分两种场景：装在自己电脑（Windows/macOS）与部署到云服务器 VPS。
 */
export function SetupGuide({ onBack }: Props) {
  const [tab, setTab] = useState<'local' | 'vps'>('local');

  return (
    <div className="login-wrap">
      <div className="login-card guide">
        <img src={logoUrl} alt="" className="login-logo" />
        <h1>
          三步部署<i>你的</i>笔记服务
        </h1>
        <p className="sub">
          Ivyea Note 是自托管软件：数据只存在你自己的服务器上，没有官方中心服务器。
        </p>

        <div className="tab-row">
          <button type="button" className={tab === 'local' ? 'tab active' : 'tab'} onClick={() => setTab('local')}>
            Windows / macOS（装在自己电脑）
          </button>
          <button type="button" className={tab === 'vps' ? 'tab active' : 'tab'} onClick={() => setTab('vps')}>
            云服务器 VPS
          </button>
        </div>

        {tab === 'local' ? (
          <ol className="steps">
            <li>
              <b>安装 Docker Desktop</b>
              <br />
              到 <code>www.docker.com/products/docker-desktop</code> 下载安装并启动，等托盘/菜单栏的鲸鱼图标变绿。
            </li>
            <li>
              <b>下载部署包并解压</b>
              <br />
              在本项目 GitHub 的 Releases 页下载 <code>IvyeaNote-deploy.zip</code>，解压到任意目录（如 <code>D:\IvyeaNote</code>）。
            </li>
            <li>
              <b>
                双击 <code>start.bat</code>（macOS 在终端执行 <code>sudo ./install.sh</code>）
              </b>
              <br />
              等它跑完，桌面会出现「IvyeaNote-账号.txt」。回到登录页点「导入账号文件」选中它，三栏自动填好，点登录即用。
            </li>
          </ol>
        ) : (
          <ol className="steps">
            <li>
              <b>准备一台 VPS，解析域名</b>
              <br />
              最低 1 核 1G 即可；在域名服务商处添加 A 记录，把你的域名指向服务器公网 IP。
            </li>
            <li>
              <b>下载部署包，配置域名</b>
              <br />
              Releases 页下载 <code>IvyeaNote-deploy.zip</code> 上传解压；编辑 <code>deploy/.env</code>，把 <code>IVNOTE_DOMAIN=</code> 改成你的域名。
            </li>
            <li>
              <b>
                执行 <code>sudo ./install.sh</code>
              </b>
              <br />
              脚本自动生成密钥与管理员密码、启动服务，并在部署目录生成「IvyeaNote-账号.txt」。首次用域名请按脚本尾部注释配好 nginx 与证书，之后服务器地址就是{' '}
              <code>https://你的域名</code>。
            </li>
          </ol>
        )}

        <div className="guide-faq">
          <p>
            <b>「服务器地址」到底填什么？</b>
            <br />
            就是账号 txt 里「服务器地址」那一栏。装在自己电脑 = <code>http://127.0.0.1:8080</code>（仅本机可访问）；部署到 VPS ={' '}
            <code>https://你的域名</code>（手机、任何设备都能连）。用「导入账号文件」则完全不用手填。
          </p>
          <p>
            <b>手机怎么同步？</b>
            <br />
            手机与电脑同一 Wi-Fi 时可连 <code>http://电脑局域网IP:8080</code>；部署到 VPS 则随时随地都能同步。
          </p>
        </div>

        <button type="button" className="btn primary" onClick={onBack}>
          我部署好了，去登录
        </button>
      </div>
    </div>
  );
}
