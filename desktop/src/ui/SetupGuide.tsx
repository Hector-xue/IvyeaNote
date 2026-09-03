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
            用自己的电脑当服务器
          </button>
          <button type="button" className={tab === 'vps' ? 'tab active' : 'tab'} onClick={() => setTab('vps')}>
            云服务器 VPS
          </button>
        </div>

        {tab === 'local' ? (
          <ol className="steps">
            <li>
              <b>打开「设置 → 同步 → 在这台电脑上开启同步」</b>
              <br />
              桌面版<b>自带同步服务端</b>，不需要 Docker、不需要下载别的东西、也不用想账号密码——
              打开这个开关就好，数据只落在这台电脑上。
            </li>
            <li>
              <b>让手机连上来</b>
              <br />
              开关打开后，下面会显示这台电脑的局域网地址（形如 <code>http://192.168.x.x:8080</code>），
              旁边有「生成配对码」。手机连同一个 Wi-Fi，打开 Ivyea Note →「开启同步」→
              「找找附近的电脑」，再填那 6 位配对码即可。
            </li>
            <li>
              <b>就这样</b>
              <br />
              电脑开着时两端自动同步；电脑关机或退出程序时同步暂停，两边的笔记都还在，
              下次开机自动接着走。想随时随地同步、不受"电脑得开着"限制，再看右边那个 VPS 方案。
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
            用自己的电脑当服务器：地址就是设置里显示的那个 <code>http://192.168.x.x:8080</code>
            （<code>127.0.0.1</code> 只有电脑自己能连，手机连不上）。用「找找附近的电脑」
            或配对码时，这一栏根本不用碰。部署到 VPS：<code>https://你的域名</code>。
          </p>
          <p>
            <b>手机连不上电脑怎么办？</b>
            <br />
            先确认三件事：电脑上的开关是开的、两台设备连的是同一个 Wi-Fi、
            电脑的防火墙放行了 8080 端口（Windows 首次会弹窗问，要选「允许」）。
            部分路由器开了「AP 隔离 / 客户端隔离」会挡住设备互访，关掉它即可。
          </p>
          <p>
            <b>还想用 Docker？</b>
            <br />
            也支持：Releases 页下载 <code>IvyeaNote-deploy.zip</code>，
            <code>start.bat</code>（macOS/Linux 是 <code>sudo ./install.sh</code>）会起一套
            Docker 服务并生成「IvyeaNote-账号.txt」，回到登录页展开「用自己的服务器」→
            「导入账号文件」选中它即可。桌面版内置服务端出来之后，这条路已经不是必需的了。
          </p>
        </div>

        <button type="button" className="btn primary" onClick={onBack}>
          我部署好了，去登录
        </button>
      </div>
    </div>
  );
}
