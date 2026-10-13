# 离线 Xid 规则

默认使用内置中文 Xid 规则。“Xid 查询”提供内置中英文目录，“排查手册”提供按主题整理的步骤与条件。

在“解析规则”点击“导入规则”，选择 XLSX 表格或规则 JSON（最大 10 MB）。导入成功后显示文件名、数量、来源和校验值，可搜索查看规则。导入失败保留原规则。

新规则用于之后导入和重新解析的报告，已有报告保留原来的说明与来源。导入配置保存在 `runtime/rules`，重启后继续使用；“恢复默认”使用当前构建内置的规则。

XLSX 需包含 `Xids` 和 `Resolution Buckets` 工作表，沿用官方表格的列次序。JSON 使用本工具生成的规则格式。

### 从命令行生成规则

如果已有兼容的 Xid 工作簿，可在本机生成规则：

```sh
python -m pip install openpyxl==3.1.5
python tools/import_catalog.py your-catalog.xlsx --output app/xid_catalog.local.json
```

生成的文件放在源码的 `app` 目录中，或放在 `XidLens.exe` 旁，未在界面导入规则时，重新启动程序即可自动载入。界面保存的配置优先生效。

需要指定其他位置时，在 PowerShell 中启动：

```powershell
$env:XIDLENS_CATALOG = (Resolve-Path app/xid_catalog.local.json).Path
python app/main.py
```

构建带自有规则的 Windows EXE：

```sh
python tools/build_windows.py --catalog app/xid_catalog.local.json
```

表格需包含 `Xids` 和 `Resolution Buckets` 工作表，沿用官方表格的列次序。生成器检查工作表及编号，保留来源文件名、SHA-256、行号和架构字段。

生成的 `*.local.json` 已加入忽略规则。请在分发包含自有规则的构建前确认资料的分发条件。代码的 MIT 许可证不授予第三方手册或译本的权利。
