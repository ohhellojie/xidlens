# 资料更新

“Xid 查询”和“排查手册”分别在“版本与更新”中显示当前版本、日期、资料来源与更新来源。检查更新后，可选择更新当前资料。

资料保存在 `runtime/knowledge`，重启后继续使用。更新包下载、校验并保存成功后才替换当前内容；失败保留原资料。更新资料不修改解析规则和已有报告。

## 制作资料包

内置资料位于 `app/knowledge/xid.json` 与 `app/knowledge/manual.json`，采用 JSON 格式，`schema` 为 `1`。修改内容时更新 `version`（三段数字版本号）、`updatedAt`（YYYY-MM-DD）及 `sources`。Xid 包包含中英文目录、未使用编号和解码表；手册包包含主题、步骤、分支和来源。

```sh
python tools/package_knowledge.py xid
python tools/package_knowledge.py manual
```

也可用 `--input` 指定资料 JSON，`--output` 指定输出目录。工具校验格式与引用后生成资料包和 SHA-256 清单，默认输出到 `dist/knowledge`。

## 发布格式

两类资料各自使用一个非草稿、非预发布的 GitHub Release：

| 类型 | 标签格式 | 下载附件 |
| --- | --- | --- |
| Xid 查询 | `knowledge-xid-v1.0.1` | `XidLens-xid.json` |
| 排查手册 | `knowledge-manual-v1.0.1` | `XidLens-manual.json` |

标签版本须与 JSON 中的 `version` 一致，并高于当前资料版本。客户端读取本项目 Releases，核验附件地址、大小、GitHub 提供的 SHA-256、包类型与格式。资料包只包含数据，不加载脚本。

每项保留官方来源；中文内容为非官方译文，第三方资料的权利归原权利人。
