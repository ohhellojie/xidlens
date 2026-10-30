# 摘要模块接口

界面操作、模型配置和输入限制见[整理摘要](evidence-assistant.md)。以下接口用于接入后端请求、前端事件与原文定位。

## 后端

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

## 前端

`XidEvidence.render(report, ctx)` 的可选 `ctx.onAssist({package, binding, exportEdited})` 接收后端重新生成的脱敏预览包。回调须同步调用 `XidAssistant.prepareEvidence(package, binding)`，成功后再进入整理页面；`binding` 包含 `caseId`、`revision` 和 `identity`。未配置回调时不显示整理按钮。转换器校验片段数量、文本长度和编码后的输入大小，超限时拒绝整批输入，不截断。

前端入口为 `XidAssistant.render(ctx)`。将转换器返回的 `input`、`sources`、`caseId`、`revision` 和 `identity` 放入 context；`ctx.protocol` 使用本机后台返回的固定规则，`ctx.exportEdited` 控制临时编辑未带入的提示。`sources` 是引用编号到 `{reportId, revision, identity, start, end}` 的本机映射，不进入发送内容。证据、版本或来源改变时，旧预览和结果失效。

`ctx.onRequest(payload, {signal})` 仅在确认发送后调用，须同步序列化请求、使用传入的取消信号并返回 Promise；前端随即清空对象中的密钥字段。委托 `click`、`change` 和 `input` 事件，使用 `ctx.render` 重绘。离开页面调用 `XidAssistant.reset()`。`ctx.onCopy(text)` 和 `ctx.onSelectEvidence()` 分别接入复制和证据选择。

`ctx.onSource({reportId, revision, identity, start, end, refId, edited})` 接收冻结的本机来源映射。宿主读取限定的原始行前须重新核对版本，使用对话框显示原文；`edited` 为真时注明片段已编辑。此回调不提供正文或模型返回的来源字段。没有可信映射时不提供原文操作。

测试使用合成片段、模拟传输和本机 HTTP 服务，不需要真实 API 密钥，也不访问外部模型。
