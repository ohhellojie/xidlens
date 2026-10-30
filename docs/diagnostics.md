# 状态、异常检查与机器拓扑

导入日志后，在状态解析中选择 GPU 和采集记录。参数按原始层级分组，保留零值、`N/A`、MIG 实例范围和原文行号。多次采集的 `nvidia-smi -q` 输出可切换查看。

状态字段、检查设备、同项记录和长证据列表每页最多显示 100 条，搜索与筛选覆盖全部记录。`GPU requires reset`、`Unknown Error` 等工具报错归入读取失败，并保留原文。UUID、序列号等设备字段从有效返回值中提取。

异常检查显示 PCIe 协商值差异、驱动绑定、PCIe 错误状态位、AER 记录以及 ECC、行重映射等状态。每项包含观察结果、说明和原文证据，可跳转到对应设备或状态字段。

检查矩阵按 GPU、网卡和其他设备分组，相同设备的同类记录合并到一个单元格。点击单元格查看说明，方向键切换相邻项目。搜索、设备类型和状态筛选可组合使用，原文证据按需展开。

矩阵直接显示发现错误、待核实、未见异常和数据缺失。已采集字段但没有对应检查结论时显示查看采集值，可打开状态参数；其他单元格按情况显示未采集、不适用、无记录或已筛除。

| 状态 | 范围 |
| --- | --- |
| 发现错误 | 日志记录了错误、非零不可纠正计数或错误状态位置位 |
| 待核实 | 采集值需要结合配置、负载、采集时间或后续增量核对 |
| 未见异常 | 该项已采集字段满足检查条件 |
| 数据缺失 | 所需字段缺失、不完整或无法唯一关联 |

每项结果对应所列的日志证据。累计计数表示统计周期内的错误总量，发生时间需查看带时间戳的错误记录，增长情况需比较同一统计周期内的多次采集。端口错误结合上下游设备定位。

机器拓扑提供 PCIe 连接树和 GPU 互联矩阵。连接树包含 GPU、PCIe 桥、网卡、NVMe 及其他 PCI 设备，以唯一的桥 secondary bus 或明确的 sysfs 路径建立父子连接。有歧义的连接保留为未关联。日志中的 `lscpu` 提供 NUMA 与 CPU Socket 对应关系时，显示 CPU Socket。

日志包含已启用的 SR-IOV 能力、VF 数量、偏移和步长时，会核对设备地址、厂商与设备 ID，将可唯一关联的虚拟功能（VF）归到物理功能（PF）下。已确认的 VF 从物理 GPU 计数中排除，链路检查以所属 PF 为对象。信息不足时保留原始设备。地址计算参考 [Linux PCI SR-IOV 实现](https://github.com/torvalds/linux/blob/master/drivers/pci/iov.c)。

互联矩阵支持 `nvidia-smi topo -m` 和 `-mp` 文本，保留 GPU、NIC 标号、连接类型和亲和性列。GPU 设备关联要求索引与 PCI 地址一一对应。NIC 通过矩阵的 NIC Legend 和网卡的 sysfs 路径关联；对应关系缺失或冲突时，显示原始标号。

矩阵可切换 GPU 之间、GPU 与网卡或全部设备的连接，支持聚焦单个设备。超过 16 行或列时分组显示，滚动时保留表头；设备详情显示网卡名称和亲和性。关系码描述设备间的连接路径，未知码保留原值，缺失行留空。单个矩阵最多读取 256 个设备，超限会提示读取不完整。连接树将上游未确认的设备集中列出。

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
