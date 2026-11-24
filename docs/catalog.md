# 离线与在线 Xid 规则

默认使用内置中文 Xid 规则。左侧「Xid 目录」提供官方中英文对照，「排查手册」按主题整理步骤、交互式流程图与参考命令。

在线更新可在左下角「软件更新」中点击「检查更新」，获取并应用最新的 NVIDIA 官方 Xid 解析规则。新规则用于之后导入和重新解析的报告，每份报告会记录解析时使用的说明与来源；规则配置保存在 `runtime/rules`，重启后继续生效。

如需使用自有或离线准备的 XLSX 表格（需包含 `Xids` 和 `Resolution Buckets` 工作表，沿用官方表格列次序），可通过下方命令行生成本地规则文件。

### 从命令行生成规则

如果已有兼容的 Xid 工作簿，可在本机生成规则：

```sh
python -m pip install openpyxl==3.1.5
python tools/import_catalog.py your-catalog.xlsx --output app/xid_catalog.local.json
```

将生成的文件放在源码的 `app` 目录中，或放在 `XidLens.exe` 旁。启动时优先使用界面保存的规则配置，其次加载该文件。

需要指定其他位置时，在 PowerShell 中启动：

```powershell
$env:XIDLENS_CATALOG = (Resolve-Path app/xid_catalog.local.json).Path
python app/main.py
```

构建带自有规则的 Windows EXE：

```sh
python tools/build_windows.py --catalog app/xid_catalog.local.json
```

生成器检查工作表及编号，保留来源文件名、SHA-256、行号和架构字段。

生成的 `*.local.json` 已加入 Git 忽略规则。分发自有规则前，请确认所含资料的授权；第三方手册和译本遵循各自许可，详见 [NOTICE](../NOTICE.md)。
