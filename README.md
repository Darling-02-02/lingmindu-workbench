# 灵敏度加满家的大肥鱼 · 多场景 AI 工作台

> 一个跑在 Electron 里的 DSH（DeepSeek Harness）桌面工作台：把「一个聊天窗口」变成「四间分工的屋子」——
> **命令**（干活）/ **B站**（刷视频 + 记录）/ **本地电脑**（清盘看账）/ **自我复盘**（写总结）。
> 这个仓库是我的实际运行版本 + 上游方法论文档的合集，会持续往里融东西。

| | |
|---|---|
| 形态 | Electron 43 外壳 ⊃ DSH 0.2.1-rc.2 引擎（HTTP 3093 + token）⊃ 26 个 cordis bundle ⊃ 场景配置 |
| 场景 | 4 个：command / bilibili / pc-cleanup / self-review |
| 规模 | 外壳 main.js ≈ 5.0k 行、renderers.js ≈ 1.1MB、styles.css ≈ 290KB |
| 平台 | Windows（Electron 43 + Node 24.9~24.x） |
| 许可 | MIT（原作者 + 我，两份版权声明都在 [LICENSE](LICENSE)） |

---

## 一、先说来源（必读）

**这个仓库是 fork，不是从零写的。**

- 上游：**[mashanglinyu/luanyujia-workbench](https://github.com/mashanglinyu/luanyujia-workbench)**（原名 `luanyujia-workbench`）
- 原作者：**淋雨家**（mashanglinyu）｜个人站 <https://linyujia.me> ｜DSH 改造集市 <https://mydsh.xyz>
- 授权：**MIT**。按 MIT 要求，原始版权声明永久保留在 [LICENSE](LICENSE) 里，我自己的改动另加一条版权行。
- 上游 README 全文**原样保留**：[`README.原版-淋雨家.md`](README.原版-淋雨家.md)。
- 仓库里 `00-核心机制/` ~ `13-公开情报/`、`12-源码照搬/`、`配图/`、`模板/`、`总纲.md`、`工具与技能目录.md`、`更新清单.md` **全部是上游原文**，我没有改（它们是这套东西的原理说明，改了就失真了）。

我做的事是：**拿上游的「公开版纯壳模板」当起点，做出自己真正在用的那一版，然后把自己的改动单独放进来。**

---

## 二、我的东西在哪

| 目录 | 是什么 | 谁的 |
|---|---|---|
| [`我的工作台/`](我的工作台/) | **我实际在跑的那一版**：外壳源码、四场景配置、工具脚本、常驻看门狗、启动链路 | 我（基于上游改） |
| [`12-源码照搬/`](12-源码照搬/) | 上游公开版模板（可直接 `npm install` 跑起来的纯壳） | 上游原样 |
| [`00-核心机制/`](00-核心机制/) ~ [`13-公开情报/`](13-公开情报/) | 上游方法论：六层结构、记忆机制、会话定位、MCP 接免费 AI、顶栏菜单… | 上游原样 |
| [`总纲.md`](总纲.md) / [`新手必读.md`](新手必读.md) / [`_索引.md`](_索引.md) | 一图看懂 + 入门路径 + 全仓索引 | 上游原样 |
| [`模板/`](模板/) / [`配图/`](配图/) | 可复制的 md 模板、拓扑图 | 上游原样 |

### `我的工作台/` 目录

```
我的工作台/
├─ 外壳/                  Electron 主进程 + 渲染层（我改过的版本）
│  ├─ main.js             主进程 273KB：进程编排、webview 治理、IPC、注入
│  ├─ preload.js          contextBridge 暴露面
│  ├─ renderer/           index.html / renderer.js / renderers.js / styles.css / skins.css …
│  ├─ scenarios/          四场景 json + _模板-网页面板.json + _场景身份索引.md
│  └─ scripts/            建会话 / 换会话 / 归档 / 刷新面板 / 自检 / CDP 诊断
├─ 工具/                  独立 node 脚本（不依赖 Electron）
│  ├─ 引擎常驻.mjs        status | start | stop | restart | token
│  ├─ 记忆同步.mjs        把引擎真实会话数据同步进场景记忆
│  └─ 场景记忆.mjs / 发消息.mjs / 封装.mjs / 发布前检查.mjs
├─ keepalive/             watchdog.ps1（30s 判活）+ 开机自启 vbs
├─ 说明/                  使用说明.md / 记忆约定.md
└─ 启动.vbs + launch-inner.cmd   双击即起的启动链路
```

> 没进仓库的：`引擎/`（= 上游 DSH npm 包本体）、`引擎数据/`（会话、附件、凭据、日志）、`node_modules/`、
> `外壳/data/`（token、日志、截图）、`*.bak-*`（我的手工备份）。这些都在 [`.gitignore`](.gitignore) 里。
> `外壳/renderer/assets/` 里的两个启动动画 mp4（12.75MB / 2.47MB）与上游模板里的完全相同，未重复提交，见 `12-源码照搬/外壳/renderer/assets/`。

---

## 三、相对上游模板，我改了什么

### 1. 引擎常驻（关掉窗口，活儿不中断）

上游模板的做法是：外壳退出 → `killServer()` 把引擎子进程一起杀掉 → 下次开窗重新等引擎冷启动（实测 67s ~ 323s）。
现在改成：

- `shell\main.js` 新增 `KEEP_ENGINE`（默认开，`DSH_KEEP_ENGINE=0` 关闭）；`killServer(force)` 在非强制时**只记日志不杀**。
- 引擎以 `detached: true` + **文件 stdio**（`外壳\data\engine.out.log`）启动——不能留 pipe，否则壳一退，引擎写 stdout 会 EPIPE 直接崩。
- token 落盘 `外壳\data\engine-token.json`；`wireDetachedProc()` 每 400ms 从日志尾部增量 tail 抓新 token。
- 重开壳时 `ensureOwnPort()` 先用落盘 token 验活（`tokenWorks()`），确认是自己那台就**直接复用**，不再误判成「别人的实例」而换端口。
- 独立脚本 `工具\引擎常驻.mjs` 可以完全不依赖 Electron 地拉起来 / 停掉 / 查状态，适合配开机自启：
  ```powershell
  node 工具\引擎常驻.mjs status
  schtasks /Create /TN "DSH引擎常驻" /SC ONLOGON /RL LIMITED /F /TR "\"C:\Program Files\nodejs\node.exe\" \"<仓库路径>\我的工作台\工具\引擎常驻.mjs\" start"
  ```

### 2. 记忆同步（让「记忆」这个词只指一件事）

上游有三套都叫「记忆」的东西，容易看懵——这也是我自己最初看不懂的地方：

| 叫什么 | 实际是 | 位置 |
|---|---|---|
| 场景记忆 | 每个场景一份手写 md，给 AI 当交接笔记 | `引擎数据\.dsh\场景记忆\<场景>\场景私有记忆.md` |
| 记忆神经元面板 | 只读的 canvas 节点图，把上面的 md + 共享记忆画成网络 | `renderers.js` 的 `renderers.neuron` |
| 引擎真实记忆 | dsh 自己的会话存档（projcache json + zstd jsonl） | `引擎数据\.dsh\storages\` / `sessions\` |

面板里的 `dataSources` 一直是空的，所以它永远只显示手画的那张图。我加了 `工具\记忆同步.mjs`：
只读引擎数据，只写 `记忆地图.json` 的 `dataSources` 和 `_共享记忆\引擎会话.json`，**绝不碰任何 `场景私有记忆.md`**（人写的东西不许程序覆盖）。
外壳侧加了 `memory:sync` IPC（30 秒节流 + 并发合并，走异步执行不卡主进程），神经元面板 `load()` 前先触发一次。
实测同步结果：会话 46（活 20 / 归档 26）、工作区 6、技能 4、事件档案 423 个 / 154.2MB。

### 3. 主题（明暗三档 + 5 套配色）

上游只有 dark / light / system。我加了 `外壳\renderer\skins.css`：
`aurora`（默认）/ `forest` / `violet` / `amber` / `rose`，每套都有对应的浅色档，实现方式是 `html[data-skin]` 覆盖 CSS 变量，
外观菜单拆成「明暗三档 ｜ 配色 5 色点」，点色点即时生效、不关菜单。

### 4. 加网页面板（零改代码）

想在工作台里多塞一个网页？不用动代码，往 `外壳\scenarios\*.json` 加一个 `"type": "embed"` 面板就行：

```json
{
  "id": "myweb", "name": "我的网页", "layout": "grid", "cols": 5,
  "panels": [
    { "id": "myweb-web", "title": "示例站", "type": "embed",
      "url": "https://example.com/", "col": 1, "row": 1, "w": 4, "h": 6,
      "userAgent": "chrome", "allowPopups": false, "sub": "说明文字" }
  ]
}
```

字段：必填 `id / title / type / url / col / row / w / h`；选填 `sub`、`userAgent`（写 `chrome` 用纯 Chrome UA）、
`allowPopups`、`failHint`、`offHint`、`embedToggle`、`expand`、`launchPath/launchLabel/launchHint`（开本地 .lnk）。
面板的 `webview` 分区按 `id` 生成（`persist:embed-<id>`），**改 id 等于换登录态**。
现成模板：[`我的工作台/外壳/scenarios/_模板-网页面板.json`](我的工作台/外壳/scenarios/_模板-网页面板.json)（`_` 开头的文件不进标签栏）。
改已有场景：保存 + 顶栏 ⟳；加新场景文件：重启壳（引擎不用重启）。

### 5. 性能（把实测结论也放这，省得后来人再猜一遍）

实测（Windows，4 个 webview 同时活着）：Electron 侧总内存 ≈1.1GB、CPU ≈2 个核。三个 A/B 实验否掉了常见猜测：

- 关掉 `animation` / `backdrop-filter` / `box-shadow` → CPU 176% → **198.7%（没降）**
- 隐藏 B站 + 外部站两个 webview → 201.6% → **206.5%（没降）**
- 在主页面跑 3 秒死循环 → 主 renderer +102%、合成宿主 renderer 只 +37%
- Blink 计数（3 秒）：`TaskDuration 89ms`、`ScriptDuration 6ms`、`Layout 0`、`RecalcStyle 0`、DOM 仅 231 节点

**结论：不是 Electron 慢，也不是 CSS 重**。真凶是两条：
① `<webview>` 标签（Electron 官方已标 legacy）挂了 4 个，多出一层 browserplugin 合成层 → 合成宿主 renderer 107% + GPU 59.6%，而 JS 只跑 6ms；
② 主页面里 20+ 个各自为政的 `setInterval`（400ms / 600ms / 1.5s / 3s / 5s…）→ 主 renderer 那 ~28%。

已做：`disable-features=CalculateNativeWinOcclusion`、`renderer-process-limit=6`、`disable-renderer-backgrounding`、
`backgroundThrottling: false`（只给 harness 面板，外站 embed 面板故意保留节流省 CPU）。
待做：定时器合并成统一 250ms 心跳调度器、`<webview>` → `WebContentsView`、场景切走就 `webContents.close()`。
诊断脚本在 [`我的工作台/外壳/scripts/`](我的工作台/外壳/scripts/)：`cdp-prof.mjs`（JS 采样）、`perf-ab.mjs`（注入式 A/B）、`cdp-eval.mjs`（Blink 计数）。

---

## 四、怎么跑起来

> 这是 Windows 桌面套件，不是 `npm start` 就能开的网页项目。

1. **Node.js 24.9+（24.x 线）** —— 引擎硬要求，`node -v` 能出版本
2. 把 **DSH 引擎**（`@deepseek-ai/dsh`）放到与 `外壳/` 同级、名字叫 `引擎`
3. `cd 我的工作台\外壳 && npm install`（第一次会下 Electron，慢是正常的）
4. 双击 `我的工作台\启动.vbs`（默认端口 3093；`launch-inner.cmd` 里可改 `DSH_PORT`）
5. 给每个场景建会话：`node 外壳\scripts\建会话.mjs "命令"`，B站 / 自我复盘 / 本地电脑同理
6. 先看 [`总纲.md`](总纲.md) 和 [`新手必读.md`](新手必读.md)，卡住看 [`12-源码照搬/README.md`](12-源码照搬/README.md) 的「常见问题」

想只看外观、不想装依赖：`11-最小可运行壳/` 是零依赖单文件 demo。

---

## 五、后续往里融什么

- [ ] UI 里直接编辑场景面板（顶部「＋」表单 → 写回 `scenarios/*.json`，带备份与网格夹取）
- [ ] `<webview>` → `WebContentsView`，定时器合并，把 2 核压到 0.3 核
- [ ] 会话结论自动回流到 `场景私有记忆.md §〇 当前交接`（要 AI 判断，做成 skill）
- [ ] 更多场景：写作 / 图纸 / 行情 …

---

## 六、责任边界

- 上游文档里的方法与原理，版权与解释权归原作者；我这边只是**用了并改了自己那一份**。
- 仓库不含任何会话数据、凭据、模型权重和别人的隐私；`引擎/`、`引擎数据/`、`node_modules/` 都不在版本控制里。
- 引擎本体（`@deepseek-ai/dsh`）请自行按官方渠道获取，本仓库不分发它。
