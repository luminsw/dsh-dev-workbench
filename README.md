# dsh-dev-workbench

三语种（C#/.NET、Kotlin/Android、ArkTS/HarmonyOS）开发工作台插件，为 DeepSeek Harness 提供：

- **构建/测试/安装工具**（`dev_build` / `dev_test` / `dev_install`，后台执行返回 opId，`dev_build_status` 查询进度）：
  - `kotlin` → `gradlew.bat :app:assembleDebug|installDebug|testDebugUnitTest`（自动 `JAVA_HOME`=Android Studio jbr JDK21；`sub` 可传完整 gradle 任务如 `:baihua-sdk:assembleRelease` 构建 SDK 模块）
  - `baihua` / `mdyjCloud` → `dotnet build|test <sub>`（sub 为子路径，如 `services/Baihua.Family`）
  - `arkts` → DevEco `hvigorw.bat assembleApp`（自动 `DEVECO_SDK_HOME`/`NODE_HOME`）
- **CI 等效完整验证**（`dev_verify`，返回 opId）：
  - `kotlin` → `gradlew :app:testDebugUnitTest :app:assembleDebugAndroidTest`（单测 + androidTest 编译两段都过）
  - `arkts` → `scripts\verify-local.ps1`（ohpm install → 单测+lint → assembleApp；`install=true` 时装真机含签名冲突处理）
  - `baihua` → `dotnet test` 三个测试项目（Family / Sdk / Huapu）
  - `mdyjCloud` → `dotnet test`（`sub` 可指定测试子路径）
- **设备与日志**（`dev_devices` / `dev_connect_adb` / `dev_logcat`）：adb devices / hdc list targets / logcat / hilog
- **设置页状态卡片**：设备状态 + 一键构建按钮 + 后台操作列表（数据源 `/dsh-dev-workbench/status`，按钮走 `/dsh-dev-workbench/ui-action`，均仅本机回环）

## 安装

```bash
cd ~/.dsh
npx @deepseek-ai/dsh plugin --profile web add "C:\Users\lumin\src\dsh-dev-workbench"
# 重启 DSH 生效（HMR 热加载在本机 Windows 环境不可靠）
```

## 配置

在 `~/.dsh/cordis.patch.yml` 按 id 覆盖（默认自动探测）：

```yaml
- id: dsh-dev-workbench
  config:
    projects: { kotlin: 'C:\\Users\\lumin\\src\\kotlin', baihua: 'C:\\Users\\lumin\\src\\baihua' }
    javaHome: 'C:\\Program Files\\Android\\Android Studio\\jbr'
    devecoHome: 'C:\\Program Files\\Huawei\\DevEco Studio'
    adbPath: ''   # 默认 PATH / Android SDK 自动探测
    hdcPath: ''   # 默认 PATH / DevEco 自动探测
```

## 开发

插件通过 pnpm link（junction）挂到 profile，host 侧源码改动在 HMR 生效时热更新（hmr root 已含本目录）；`client.js`（前端卡片）改动需重启 DSH。
