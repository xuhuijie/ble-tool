# BLE 蓝牙调试助手（网页版）

一个可直接部署到 **GitHub Pages / Gitee Pages** 的手机端 BLE（低功耗蓝牙）调试工具。纯前端、无后端，基于浏览器原生 **Web Bluetooth API**。

## 在线地址

> **在手机（Android + Chrome/Edge）上直接打开下方地址即可使用。**

- ✅ Cloudflare Workers：<https://ble-rtu-web.503012675.workers.dev>
- ✅ 自定义域名：<https://ble.bainuli.dpdns.org/>

### 后端架构（2026-10-19 起）

- Worker 内 `/api/*` 接口 + D1 数据库（`ble-tool-db`），`worker/worker.js`
- 用户表 `users`：密码 PBKDF2-SHA256（10 万次迭代）加盐哈希，HMAC-SHA256 签名 token（7 天有效，存 sessionStorage）
- 设备表 `devices`（全局共享）/ 寄存器表 `registers`
- 权限：读需登录；设备/寄存器/用户的增删改仅管理员，**由服务端强制执行**（前端只读模式只是体验优化）
- 签名密钥：`wrangler secret put AUTH_SECRET`（不进版本库）
- 蓝牙通讯仍在浏览器端（Web Bluetooth），后端不碰蓝牙

## 功能

- **设备扫描与连接**：扫描附近 BLE 设备，支持按服务 UUID 过滤
- **UART 串口透传**：配置 TX / RX 特征值 UUID，双向发收文本 / HEX 数据
- **GATT 服务/特征值浏览**：读取设备所有服务，支持 Read / Write / WriteWithoutResponse
- **通知监听**：订阅 notify / indicate，实时显示特征值变化
- **HEX + 文本双显示**：收发数据可自由切换十六进制 / 文本显示
- **Modbus RTU**：设备地址配置，支持 03/04 读寄存器、06/10 写寄存器，CRC 自动计算、响应自动校验解析；支持 16 位 / 32 位整型（LONG）/ 32 位浮点（FLOAT）解析与大小端字序
- **设备配置**：多设备管理（名称/从站地址/蓝牙绑定/字序），每设备可配置多个寄存器变量（地址、保持/输入、数据类型、单位、缩放系数/偏移量），手动一键批量读取、单个写入
- **用户权限**：本地用户管理（管理员/普通用户，SHA-256 密码哈希）；普通用户仅可见蓝牙连接与设备页、可读写但不能改配置

## 兼容性（重要）

Web Bluetooth API 目前**只支持 Android 和桌面浏览器**：

| 平台 | 浏览器 | 支持 |
|------|--------|:----:|
| Android | Chrome / Edge / 微信内置浏览器(Chromium) | ✅ |
| Android | 部分国内应用内置浏览器 | ⚠️ 需 Chromium 内核且授权蓝牙 |
| iOS / iPhone | Safari | ❌ 不支持 |
| 桌面 | Chrome / Edge | ✅（可测试界面，但无实际 BLE 外设时仅能看界面） |

> 必须在发出蓝牙请求的页面上**点击一次**按钮（用户手势），否则会被拦截。
> 需要通过 HTTPS 或 `localhost` 访问（GitHub / Gitee Pages 均满足）。

## 本地运行

任选其一：

```bash
# 方式一：Python
python -m http.server 8080

# 方式二：Node
npx serve .
```

浏览器访问 `http://localhost:8080`。（本地 localhost 可免 HTTPS 使用蓝牙。）

## 部署到 GitHub Pages / Gitee Pages

1. 把本项目推送到你的仓库（见下文）。
2. 仓库 **Settings → Pages**，Source 选择 `main` 分支根目录 `/`，保存。
3. 等待几分钟，即可通过 `https://你的用户名.github.io/仓库名/` 访问。

**在手机上访问**：直接用 Android Chrome 打开上述网址即可使用。

## 使用说明

1. 打开页面，点击 **搜索设备** → 在系统选择框中选择设备 → 点击 **连接**（可先填服务 UUID / 名称关键字过滤）。
2. 连接成功后进入 **透传** 页：填好 TX（写入）和 RX（读取/接收）特征值 UUID，点 **保存配置** 会自动订阅 RX。
3. 在发送框输入文本或 HEX（如 `01 02 A0 FF`），选择 **文本 / HEX** 模式后发送。
4. **特征值** 页可浏览所有 GATT 服务、读取与写入；**监听** 页查看所有订阅通知。

## 项目结构

```
├── index.html               # 页面结构（ES Module 单入口）
├── css/style.css            # 样式（深色移动端主题）
├── js/
│   ├── main.js              # 入口：页面流程编排 + 事件接线
│   ├── device-filter.js     # 核心筛选器：蓝牙名称筛选 / 未知设备筛选 / 服务 UUID 筛选
│   ├── ble-service.js       # 蓝牙服务层：全部 navigator.bluetooth 调用（扫描/连接/GATT）
│   ├── ui.js                # UI 基础层：日志 / 吐司 / 状态 / 渲染
│   ├── uart-panel.js        # UART 透传面板
│   ├── modbus.js            # Modbus RTU 协议：组帧 / CRC16 / 响应解析 / 数据类型编解码（纯函数）
│   ├── modbus-panel.js      # Modbus RTU 面板：地址配置 / 读写寄存器 / 结果展示（含 Promise 事务接口）
│   ├── mb-store.js           # Modbus 设备/寄存器配置存储（服务端 D1）
│   ├── mb-device-panel.js    # Modbus 设备面板：设备管理 / 寄存器配置 / 手动批量读 / 单个写（支持普通用户只读模式）
│   ├── api.js                # 后端 API 客户端（token 存 sessionStorage）
│   ├── mb-auth.js            # 用户认证（走 /api/auth，服务端 PBKDF2 + HMAC token）
│   ├── mb-user-panel.js      # 用户管理面板（仅管理员）
│   ├── protocol-panel.js    # 协议解析面板
│   ├── protocol.js          # 协议解析引擎（纯函数）
│   ├── codec.js             # 编解码：HEX / ASCII / UTF-8
│   ├── names.js             # GATT UUID / 厂商名称表
│   └── storage.js           # localStorage 持久化
└── README.md
```

### 设备筛选说明

筛选逻辑统一收口在 `js/device-filter.js` 的 `DeviceFilter` 类：

- **蓝牙名称筛选**：填「设备名称包含」关键字。系统选择框模式下受 Web Bluetooth
  API 限制只能做前缀匹配；「极简列表」模式在客户端做「包含」匹配，更灵活。
- **未知设备筛选**：勾选「只看有名称的设备」即可排除所有无名称设备。极简列表
  直接不渲染；系统选择框无法预先隐藏，选中后会兜底校验并拒绝。
- 连接失败或无 GATT 服务的设备会被自动过滤（视为未知/不支持设备）。

> 注意：使用 ES Module，需通过 http(s) 访问（本地 `python -m http.server` 或部署到
> GitHub Pages 均可），不能直接双击 index.html 用 file:// 协议打开。