# 状态、异常检查与机器拓扑

导入日志后，在「设备状态」中查看服务器概览与 GPU 清单，并按需筛选「仅异常」。选中设备后，右侧展示该卡的身份信息、PCIe 链路、ECC 与行重映射等状态检查项，保留零值、`N/A`、MIG 实例范围与原文行号。`GPU requires reset`、`Unknown Error` 等工具报错归入读取失败并保留原文；UUID、序列号等设备字段仅从有效返回值提取。

异常检查覆盖 PCIe 协商值差异、驱动绑定、PCIe 错误状态位、AER 记录以及 ECC、行重映射等状态。每项检查均附带观察结果、说明和原文行号，点击行号可在右侧原文抽屉定位，并可一键切入完整日志阅读器。

| 状态 | 范围 |
| --- | --- |
| 发现错误 | 日志记录了错误、非零不可纠正计数或错误状态位置位 |
| 待核实 | 采集值需要结合配置、负载、采集时间或后续增量核对 |
| 未见异常 | 该项已采集字段满足检查条件 |
| 数据缺失 | 所需字段缺失、不完整或无法唯一关联 |

每项结果对应所列的日志证据。累计计数表示统计周期内的错误总量，发生时间需查看带时间戳的错误记录，增长情况需比较同一统计周期内的多次采集。端口错误需结合上下游设备定位。

「机器拓扑」提供 **PCIe 连接树** 和 **互联矩阵**：

- **PCIe 连接树**：包含 GPU、PCIe 桥、网卡、NVMe 及其他 PCI 设备，以 `lspci -t` / `-tv`、唯一的桥 secondary bus 或明确的 sysfs 路径建立父子连接；存在歧义的连接会显式标记，不强行归属。日志中的 `lscpu` 提供 NUMA 与 CPU Socket 对应关系时同步展示。
- **SR-IOV 识别**：日志包含已启用的 SR-IOV 能力、VF 数量、偏移和步长时，会核对设备地址、厂商与设备 ID，将可唯一关联的虚拟功能（VF）归到物理功能（PF）下。已确认的 VF 从物理 GPU 计数中排除，链路检查以所属 PF 为对象；信息不足时保留原始设备。地址计算参考 [Linux PCI SR-IOV 实现](https://github.com/torvalds/linux/blob/master/drivers/pci/iov.c)。
- **互联矩阵**：支持两种来源并可切换：
  1. **实测矩阵（`nvidia-smi topo -m` / `-mp`）**：保留 GPU、NIC 标号、NVLink / PCIe 连接类型和亲和性信息；GPU 要求索引与 PCI 地址一一对应，NIC 通过矩阵的 NIC Legend 与 sysfs 路径关联。
  2. **自动推导 PCIe 矩阵（`lspci` 拓扑）**：当 `nvidia-bug-report.sh` 等日志缺少 `nvidia-smi topo -m` 时，自动依据 `lspci` 桥结构与 NUMA 节点推导 GPU 与网卡之间的 PCIe 互联关系（`PIX / PXB / PHB / NODE / SYS`，不含 NVLink）。
- 支持切换 `GPU ↔ GPU` 与 `GPU ↔ 网卡` 视图，点击任意单元格即可在右侧查看两端的路径层级、公共上游分叉图、NUMA 归属与原文行号。单个矩阵最多读取 256 个设备，超限时提示读取不完整。

## 采集文本

以下命令只读取信息。部分 PCIe 扩展字段需要具有相应读取权限。把命令名和输出保存在同一文本文件中，可保留来源并区分矩阵类型：

```sh
{
    echo '*** lspci -Dnnvv'
    lspci -Dnnvv
    echo '*** nvidia-smi --query-gpu=index,pci.bus_id,uuid --format=csv'
    nvidia-smi --query-gpu=index,pci.bus_id,uuid --format=csv
    echo '*** nvidia-smi -q'
    nvidia-smi -q
    echo '*** nvidia-smi topo -m'
    nvidia-smi topo -m
    echo '*** nvidia-smi topo -mp'
    nvidia-smi topo -mp
    echo '*** lscpu -e=CPU,NODE,SOCKET'
    lscpu -e=CPU,NODE,SOCKET
    echo '*** PCI sysfs paths'
    for device in /sys/bus/pci/devices/*; do readlink -f "$device"; done
    for device in /sys/class/infiniband/*/device /sys/class/net/*/device; do
        [ -e "$device" ] || continue
        echo "*** readlink -f $device"
        readlink -f "$device"
    done
} > gpu-state.txt 2>&1
```

内核 AER 与 Xid 时间记录需另外保留 `dmesg`、`journalctl -k` 或完整 `nvidia-bug-report`。各文件分别形成报告；需要在同一报告中关联的数据应保留在同一采集文本中。

旧报告可在报告管理中使用原文件重新解析。JSON 导出包含完整状态字段、拓扑关系和检查证据。

参数说明参考 [NVIDIA System Management Interface](https://docs.nvidia.com/deploy/nvidia-smi/index.html)，AER 分类参考 [Linux PCIe AER 文档](https://docs.kernel.org/PCI/pcieaer-howto.html)。
