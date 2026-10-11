# 离线 Xid 规则

默认显示 Xid 编号、原文和官方链接。导入自己的 Xid 表格后，可查看离线说明和建议。

如果已有兼容的 Xid 工作簿，可在本机生成规则：

```sh
python -m pip install openpyxl==3.1.5
python tools/import_catalog.py your-catalog.xlsx --output app/xid_catalog.local.json
```

生成的文件放在源码的 `app` 目录中，或放在 `XidLens.exe` 旁，重新启动程序即可自动载入。

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
