# 结构化诊断结果与事件

读取已有的 DCGM JSON 结果、NVSwitch SXid 日志和实验性的 GOE 记录。解析在本机进行，不启动诊断、压力测试或设备重置。

## DCGM JSON

支持 `dcgmi diag --json` 输出中的两种诊断根字段：`DCGM Diagnostic` 和旧版 `DCGM GPU Diagnostic`。读取测试类别、测试名称、逐实体结果、测试汇总、迭代结果、版本和错误说明。结果中的额外字段保留在原始文档中。

| 原始结果 | 显示含义 |
| --- | --- |
| Pass | 该次测试通过 |
| Fail | 该次测试失败 |
| Warn | 该次测试返回警告 |
| Skip | 已跳过 |
| Not Run | 未运行 |
| 无 status 或无结果 | 未记录结果 |
| 其他值 | 未知结果，保留原值 |

未列出的测试不计为通过。运行错误单列，不能据此认定硬件测试通过或失败。测试汇总与逐实体结果分别保留，检查列表优先显示逐实体结果，避免重复统计。

DCGM 的实体编号只在该份结果内使用。GPU 0、CPU 0 或其他实体编号不会自动匹配到另一份报告中的设备。

结果视图可按测试结果、实体和运行次数筛选，或搜索测试名、类别及实体。未提供实体字段的逐项结果显示“未归属设备”。测试汇总放在对应结果详情中，不重复计数；只有汇总的测试单独保留。运行错误与测试失败分开显示。

详情保留原始行号与 JSON Pointer。原始 JSON 按需展开，每次预览最多 65536 个字符，截断时显示提示；完整内容仍可从来源查看。版本与格式说明列出产生结果的 DCGM 版本、驱动版本以及版本缺失情况。

JSON 证据包含文件来源、JSON Pointer、原始起止行和原文片段。单行 JSON 的多个结果可能位于同一行，此时以 JSON Pointer 区分。每份 JSON 上限为 16 MiB、64 层嵌套、200000 个值；最多整理 10000 项结果。超过上限或内容不完整时明确标记，原文件不修改。重复 JSON 字段和非有限数值会被拒绝。

已保存报告中的动作记录或结构化结果损坏时，仅在读取视图中隔离对应部分并标记不完整，其他有效记录继续显示。原文件保留，可从报告管理重新解析。

DCGM 未提供稳定的 JSON schema。解析兼容性以字段结构为准，同时保留产生版本；版本缺失时显示提示。字段依据来自 [DCGM 命令文档](https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/index.html#json-output)、[诊断命令](https://docs.nvidia.com/datacenter/dcgm/latest/reference/command-line-reference/dcgmi/dcgmi-diag.html)及 NVIDIA 的 [JSON 字段定义](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/nvvs/include/NvvsJsonStrings.h)和[结果输出实现](https://github.com/NVIDIA/DCGM/blob/9fae2867e6e5264fa0fca22a07dc898d591baa21/dcgmi/Diag.cpp)。

## NVSwitch SXid

读取 `nvidia-nvswitchN: SXid (PCI:...): ...` 记录，保留 NVSwitch 编号、PCI 地址、SXid、端口和原文中的 fatal/non-fatal 标记。SXid 与 GPU Xid 分开，交换芯片地址不会作为 GPU 身份。

紧邻主记录、设备与 SXid 相同的 `Severity`、`Data` 补充行附在同一记录下，并分别保留行号。重复出现的主记录仍是多次记录；跨启动标记、不同设备或非连续补充行不会合并。只有补充行时，严重性显示未知。

事件列表、时间线与联合分析使用独立的 NVSwitch 设备标识。相同 PCI 地址的 GPU 与 NVSwitch 分别筛选、分组及计数。补充行可从事件详情逐条打开。

格式与适用范围见 [NVIDIA Fabric Manager](https://docs.nvidia.com/datacenter/tesla/fabric-manager-user-guide/index.html#runtime-nvswitch-and-gpu-errors)。SXid 的 fatal/non-fatal 机制不适用于所有代际的 NVSwitch，解读时需核对平台。

## GOE（实验性）

GOE 使用完整的“模块、类别、模块事件码”识别事件类型，不能只看其中一个编号。保留作用范围、严重性、日志级别、设备 UUID、时间和关联字段。未知字段继续保留。

### event-log 文本

读取由 `nvidia-smi event-log` 命令行或 `GPU Operational Events` 标题明确标识的文本块。识别 `Source Module`、`Category`、`Module Event Code` 等字段，数值可以直接显示，也可以跟在名称后的括号中。缺少完整数值标识的块不会被补成已知事件。

这是字段式预览解析，需按实际驱动输出核对原文。`event-log` 当前显示的 `Severity` 属于主机范围的 CPER 严重性，界面保留此范围，不能将它直接当作 GPU 的事件严重性。原始文本中的未知字段也保留。

### XidLens 交换 JSON

以下是 XidLens 的交换格式，供已有 NVML 采集程序导出数据使用，不是 NVIDIA 定义的 JSON 文件格式。根字段必须显式声明格式和版本。

```json
{
  "format": "xidlens-goe",
  "formatVersion": 1,
  "driverVersion": "620.0",
  "events": [
    {
      "moduleSignature": "GPU-GSP",
      "category": 1,
      "moduleEventCode": 1,
      "severity": 30,
      "logLevel": 50,
      "scope": 1,
      "deviceUUID": "GPU-DEMO-001",
      "originator": "1",
      "instanceId": "8",
      "timestamp": "1793318400123456",
      "traceId": "9007199254740993",
      "groupCursor": "9007199254740994",
      "groupPosition": 0,
      "legacyXid": 119,
      "contexts": []
    }
  ]
}
```

示例标识均为合成数据。`timestamp` 是 Unix 微秒时间，64 位标识使用十进制字符串以避免 JavaScript 数值精度损失。`category` 和 `moduleEventCode` 必须为 16 位无符号数；`moduleSignature` 最长 15 个 ASCII 字符。`contexts` 和其他附加字段原样保留。

只有设备 UUID、originator、instance ID、微秒时间和完整事件类型都一致，且载荷相同，才将 GOE 的重复表示合为一条事件；所有来源仍保留。相同 Trace ID 只能说明关联事件，不用于合并事件。标识相同而载荷不同的记录保留并标记冲突。

Legacy Xid 编号只作为关联提示，不自动合并 Xid 与 GOE。当前导入按来源文件独立处理，GOE 去重仅覆盖同一来源中标识和载荷完整一致的重复表示，不执行 Xid 与 GOE 的跨格式合并。输出的 `relations` 保留 Legacy Xid 提示及未合并原因，`occurrenceCount` 记录事件次数。

时间线和联合分析显示完整事件类型与严重性范围。重复来源保留各自的行号和 JSON Pointer，按页查看；来源数量与事件次数分别显示。没有可靠 GPU 身份关联时，设备 UUID 独立保留。

GOE 文档仍处于预览期，标识和字段可能随驱动变化。格式依据为 [事件分析](https://docs.nvidia.com/deploy/gpu-operational-events/analyzing-gpu-operational-events.html)和[事件格式](https://docs.nvidia.com/deploy/gpu-operational-events/event-formats.html)。
