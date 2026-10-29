# 证据辅助

证据辅助只接收已选择的脱敏片段。默认的本机整理按片段摘录并保留引用编号，不调用 AI，也不访问网络。摘要可以编辑、复制；原始证据不会被覆盖。

在证据与分享中选择已保存的书签，点击按书签整理。工具按当前脱敏设置重新生成各片段，包含已保存的标题、备注和标签。导出预览中的临时编辑不会带入，进入助手后需重新核对。

每个片段可以编辑或取消选择。修改后的片段标记为已编辑，本机整理和模型预览使用修改后的内容。核对原文始终使用书签原来的报告、版本和行范围；正文或摘要中的行号不参与定位。原文核对在当前页打开，关闭后继续编辑摘要。

## 模型辅助

选择模型辅助，填写兼容 API 地址和模型名称。点击检查发送内容，核对完整片段、备注、目标接口和模型，再点击确认发送至模型。完整请求中的固定整理规则和参数可展开查看。API 密钥单独输入，可以留空，不显示在预览内容中；发送、修改预览或离开页面时清空。修改证据或配置后需要重新预览。

支持 OpenAI Chat Completions 兼容接口：

| 配置 | 示例 |
| --- | --- |
| 本机服务 | `http://localhost:11434/v1` |
| HTTPS 服务 | `https://api.example.com/v1` |
| 完整请求地址 | `https://api.example.com/v1/chat/completions` |

示例域名不提供模型服务。模型名称使用实际服务提供的名称。接口须支持 `response_format: {"type":"json_object"}`、`max_completion_tokens` 和非流式响应。请求不启用工具调用，明确设置 `store: false`。兼容服务是否遵守这些参数及如何处理数据，由服务方决定。

非本机地址必须使用 HTTPS。HTTP 仅允许 `localhost`、`127.0.0.0/8` 或 `::1`；HTTP `localhost` 固定连接 IPv4 回环地址。拒绝 URL 中的凭据、查询参数和片段，不跟随重定向，不使用环境代理，不自动重试。TLS 使用系统信任证书。

取消等待会停止界面等待并忽略迟到的响应，无法撤回已经发送到模型的内容。模型连接与读取设置 30 秒超时，域名解析由系统处理；关闭页面也不会保证远端模型停止生成。

## 结果与引用

模型返回证据中的观察、待核实事项和摘要。每条必须引用本次发送的证据编号，未知引用、无引用、无效 JSON、拒绝或截断的响应均不采用。引用校验确认编号存在，不自动验证模型的文字结论；使用前仍需核对原文。

依据 [OpenAI 的结构化输出说明](https://developers.openai.com/api/docs/guides/structured-outputs)，JSON 模式不保证字段符合指定结构，因此返回内容还要经过本地字段、类型、长度和引用校验。界面以纯文本显示模型结果。

API 密钥仅用于本次请求的认证头，不写入报告、设置、日志或结果。输入和输出不自动保存。证据、来源名称和补充说明都在发送预览中显示；发送前应检查其中是否仍有不需要外发的信息。

## 输入与限制

每次选择 1 至 32 条证据，单条文本最多 16000 字，来源名称最多 256 字，备注最多 4000 字。证据 JSON 上限 128 KiB，完整模型请求体上限 160 KiB，均按序列化后的 UTF-8 字节数检查。JSON 字符串转义会扩大请求体；证据低于 128 KiB 时仍可能需要缩减。响应上限 256 KiB。模型输出的三类条目各最多 16 条，每条最多 1600 字。

后端入口为 `assistant.request_assistance(payload, transport=None)`。本机整理使用 `{"mode":"offline","input":selected}`；省略 `mode` 也采用本机整理。`selected` 只包含备注和证据片段：

```json
{
  "text": "仅整理所选片段",
  "evidence": [
    {"id": "e1", "text": "Synthetic Xid 79", "source": "报告 1", "line": 12}
  ]
}
```

模型路径使用 `assistant.protocol()` 提供的固定规则和参数构造完整请求。确认后提交 `{mode, confirmed, endpoint, apiKey, preview}`，其中 `preview` 是实际发送的 Chat Completions 请求对象，证据只在 `preview.messages[1].content` 中出现一次。后台提取并校验证据，核对规则、参数和消息角色；预览缺失或不一致时停止发送。

`assistant.preview_request(selected, model)` 可构造同样的请求对象。模型结果中的 `observations`、`uncertainties`、`summary` 均为 `[{"text":"…","refs":["e1"]}]`，并提供可编辑的 `summaryText`。`AssistanceError.code` 和异常文本使用固定错误信息，不包含服务端原始错误正文。

`XidEvidence.render(report, ctx)` 的可选 `ctx.onAssist({package, binding, exportEdited})` 接收后端重新生成的脱敏预览包。回调须同步调用 `XidAssistant.prepareEvidence(package, binding)`，成功后再进入助手；`binding` 包含 `caseId`、`revision` 和 `identity`。未配置回调时不显示整理按钮。转换器校验片段数量、文本长度和编码后的输入大小，超限时拒绝整批输入，不截断。

前端入口为 `XidAssistant.render(ctx)`。将转换器返回的 `input`、`sources`、`caseId`、`revision` 和 `identity` 放入 context；`ctx.protocol` 使用本机后台返回的固定规则，`ctx.exportEdited` 控制临时编辑未带入的提示。`sources` 是引用编号到 `{reportId, revision, identity, start, end}` 的本机映射，不进入发送内容。证据、版本或来源改变时，旧预览和结果失效。

`ctx.onRequest(payload, {signal})` 仅在确认发送后调用，须同步序列化请求、使用传入的取消信号并返回 Promise；前端随即清空对象中的密钥字段。委托 `click`、`change` 和 `input` 事件，使用 `ctx.render` 重绘。离开页面调用 `XidAssistant.reset()`。`ctx.onCopy(text)` 和 `ctx.onSelectEvidence()` 分别接入复制和证据选择。

`ctx.onSource({reportId, revision, identity, start, end, refId, edited})` 接收冻结的本机来源映射。宿主读取限定的原始行前须重新核对版本，使用对话框显示原文；`edited` 为真时注明助手片段已编辑。此回调不提供正文或模型返回的来源字段。没有可信映射时不提供原文操作。

测试使用合成片段、模拟传输和本机 HTTP 服务，不需要真实 API 密钥，也不访问外部模型。
