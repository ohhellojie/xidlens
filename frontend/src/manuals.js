import data from './catalog.json';
const base='https://docs.nvidia.com/deploy/gpu-debug-guidelines/';
export const sources={
 catalog:['Xid Catalog · 中文译本 2026-09-09','https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html'],
 triage:['GPU Node Triage · 2026-10-04',base+'gpu-node-triage.html'],
 initial:['Initial Incident Report',base+'initial-incident-report.html'],
 best:['Best Practices',base+'best-practices.html'],
 smi:['NVIDIA System Management Interface','https://docs.nvidia.com/deploy/nvidia-smi/index.html'],
 dcgm:['DCGM Diagnostics · latest','https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/dcgm-diagnostics.html'],
 nccl:['NVIDIA / nccl-tests','https://github.com/NVIDIA/nccl-tests'],
 sanitizer:['Compute Sanitizer','https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html'],
 systems:['Nsight Systems User Guide','https://docs.nvidia.com/nsight-systems/UserGuide/index.html'],
 compute:['Nsight Compute','https://docs.nvidia.com/nsight-compute/NsightCompute/index.html']
};
export const topics=[
 {id:'start',group:'开始排查',title:'记录现象与变化',sub:'时间、范围与复现条件',scope:'先记录现象，再选择对应排查路径。',refs:['initial'],related:[],next:['collect','79','13'],steps:[
 ['确定时间与范围','记录首次发生时间、频率、受影响的设备和应用。区分持续故障与偶发故障。'],
 ['核对近期变化','对照故障前后的系统、驱动、应用版本及配置；记录哪些条件下可以复现。'],
 ['保留原始描述','保留完整错误信息和已做的检查。尚未验证的原因单独标记，避免把现象写成结论。']]},
 {id:'collect',group:'开始排查',title:'收集诊断信息',sub:'系统、驱动与完整日志',scope:'尽量在恢复操作前保存故障现场。命令示例用于 Linux。',refs:['triage'],related:[],next:['diag'],steps:[
 ['基本信息','保存系统与驱动版本、故障时间、完整日志和已执行步骤。应用相关问题补充框架版本及复现条件。'],
 ['诊断附件','收集 nvidia-bug-report；HGX 补充 Fabric Manager 日志，已运行诊断则保留 DCGM 输出。'],
 ['建立设备对应关系','对照日志中的 UUID、PCI 地址和可用的 SN。缺失字段留空，不凭 GPU 序号跨报告认定同一设备。']]},
 {id:'79',group:'按现象查找',title:'GPU 无法访问',sub:'Xid 79 · PCIe',scope:'Xid 79 表示驱动无法通过 PCIe 访问 GPU。具体原因需要结合故障前后的记录。',refs:['catalog'],related:['79','154'],next:['collect','diag','reset'],extracts:['79'],steps:[
 ['定位目标','记录事件中的 PCI 地址，与同份报告里的 UUID、SN 对照。检查掉卡前后的错误，保留事件顺序。'],
 ['核对恢复建议','查看 Xid 79 及伴随 Xid 154 的恢复操作；确认复位条件后再安排恢复。'],
 ['复查是否重现','恢复后重新检查设备可见性。再次发生时保留新旧日志，按目录建议继续诊断。']]},
 {id:'13',group:'按现象查找',title:'应用异常',sub:'Xid 13 / 31 · CUDA 调试',scope:'单条 Xid 不能直接区分应用、驱动或硬件问题。先看重复出现的位置与复现规律。',refs:['catalog','sanitizer'],related:['13','31','43','45'],next:['diag','collect','performance'],extracts:['13','31'],steps:[
 ['比较重复位置','Xid 13 关注 TPC / GPC / SM；Xid 31 关注是否总在同一 PCI 地址上出现。保留多次复现记录。'],
 ['按现象选择路径','相同硬件位置反复异常：按目录工作流进行 DCGM EUD，必要时做现场诊断。零散或跨 GPU 发生：检查应用与 CUDA；不能仅凭分布排除硬件。'],
 ['检查内存访问','Compute Sanitizer 的 memcheck 可检查越界和未对齐访问。它会实际运行应用，应使用可复现的测试输入。'],
 ['保留调试结果','记录错误位置、调用栈与应用版本。应用确认正确但仍报错时，按目录要求提交完整复现材料。']],commands:[{title:'内存访问检查 · Linux 示例',code:'compute-sanitizer --tool memcheck ./your_app',note:'将 your_app 替换为测试程序，并补上程序参数。'}],table:{title:'其他检查工具',head:['工具','用途'],rows:[['racecheck','共享内存访问竞争'],['initcheck','未初始化的内存访问'],['synccheck','同步原语使用错误']]}},
 {id:'48',group:'按现象查找',title:'显存与 ECC',sub:'Xid 48 / 63 / 64 / 94 / 95',scope:'先核对 GPU 架构、伴随 Xid 和 MIG 状态，再选择恢复路径。',refs:['catalog','triage'],related:['48','63','64','92','94','95'],next:['reset','diag','collect'],steps:[
 ['还原事件组合','对齐同一 GPU 的时间线，查看 48 后是否出现 63 / 64，63 是否伴随 94；不要把不同 GPU 的事件混在一起。'],
 ['选择对应分支','以下按当前中文目录整理。A100 平台手册的特殊条件另列，执行前核对适用版本。']],branches:[
 {label:'48',title:'不可纠正 ECC',text:'单独出现：目录要求 RESET_GPU，并运行现场诊断。伴随 63 / 64：排空任务后复位。FB 错误继续按 63 / 64 处理；其他 SRAM 需检查错误阈值标志。',code:'48'},
 {label:'63',title:'重映射／页面退役记录',text:'Ampere 及更新架构对应行重映射，旧架构对应页面退役。单独的记录事件无需操作；伴随 48 或 94 时，按相应错误分支处理。',code:'63'},
 {label:'64',title:'记录失败',text:'当前目录要求复位 GPU，并联系支持。保留记录失败前后的错误及复位后的状态。',code:'64',extra:'A100 的 GPU Node Triage 表要求立即重启节点；与当前目录的 RESET_GPU 表述不同。先按 GPU、驱动及平台恢复要求核对，不能直接互换。'},
 {label:'94',title:'受控 ECC 错误',text:'重启受影响的应用，其他未受影响的应用可继续。安排合适时间复位 GPU 或重启，使行重映射生效；继续观察是否出现新的错误。',code:'94'},
 {label:'95',title:'未受控 ECC 错误',text:'可能影响多个应用。当前目录要求先复位受影响的 GPU，再重启应用；伴随其他故障时还需处理原始故障。',code:'95',extra:'A100 平台表：MIG 开启时，等待其他实例任务排空后复位；MIG 关闭时要求立即重启节点。这与当前目录的复位建议存在差异，执行前核对适用平台和版本。'}
 ],table:{title:'复查项目',head:['检查项','保留内容'],rows:[['ECC','可纠正／不可纠正错误、易失／累计计数及是否继续增长'],['重映射','待生效、失败状态及前后变化；区分显存与 SRAM'],['恢复','应用是否恢复、设备是否可访问、是否出现新的关联 Xid']]}},
 {id:'74',group:'按现象查找',title:'NVLink 异常',sub:'Xid 74 · 链路与对端',scope:'链路报错也可能来自对端 GPU；先检查伴随错误。',refs:['catalog'],related:['74','144','145','146','147','148','149','150'],next:['collect','diag','reset'],extracts:['74'],steps:[
 ['保留完整错误行','记录全部十六进制字段、链路与 GPU 对应关系。不要只保留 Xid 编号。'],
 ['按寄存器和位值分支','Xid 74 的工作流区分 ECC / Parity、信号完整性、机械连接和次生错误；完整寄存器指引可在下方展开。'],
 ['追查对端与持续性','有其他关联错误时，先按原始错误处理；持续出现时按对应分支检查连接并诊断。'],
 ['核对新编号解码','144–150 使用各自的子代码表；先选中编号，再按驱动版本查看 IntrInfo 与 ErrorStatus。']]},
 {id:'network',group:'按现象查找',title:'多节点通信',sub:'NCCL · 性能基线与慢节点',scope:'测试会占用 GPU 和网络。使用一致的软件、拓扑和负载条件比较。',refs:['triage','nccl'],related:[],next:['health','performance','collect'],steps:[
 ['建立基线','按相同拓扑比较节点对。发现慢组合后，更换对端复测；多网卡路径分别比较。'],
 ['区分测试范围','单节点多卡测试可检查本机通信。跨节点测试需 MPI 构建（MPI=1）、节点分配与匹配的运行环境。'],
 ['保留可比结果','保存完整命令、GPU 数、消息大小、软件版本与输出。示例 GPU 数按实际分配调整。']],commands:[{title:'单节点 8 GPU · NCCL 官方示例',code:'./build/all_reduce_perf -b 8 -e 128M -f 2 -g 8',note:'消息从 8 B 到 128 MiB，每次翻倍；此命令不代表跨节点网络测试。'}]},
 {id:'performance',group:'按现象查找',title:'性能下降',sub:'Nsight · 系统时间线与内核',scope:'先固定输入、规模与运行环境，保留正常和异常两组结果。',refs:['systems','compute'],related:[],next:['health','network','13'],steps:[
 ['查看系统时间线','Nsight Systems 用于观察 CPU、CUDA 调用和 GPU 活动的时间关系。先定位等待、空闲或传输集中出现的位置。'],
 ['分析目标内核','Nsight Compute 用于检查 CUDA 内核的性能指标。已有具体慢内核时，再深入看计算与内存访问。'],
 ['验证变化','每次只改变一项条件，复测同一工作负载。采样和分析有额外开销，保留工具配置，不把分析耗时直接当作正常运行耗时。']]},
 {id:'diag',group:'进一步检查',title:'DCGM 与现场诊断',sub:'级别、结果与后续操作',scope:'先确认 GPU 已空闲，并核对当前 DCGM 对设备与配置的支持。长测试会施加负载。',refs:['dcgm'],related:[],next:['collect','health'],steps:[
 ['选择级别','按目的选择诊断级别；实际项目取决于 DCGM 版本与设备支持。'],
 ['按结果继续','失败时查看具体测试、GPU 和错误详情；未执行或不支持的项目不能视为通过。保留完整输出及退出码。'],
 ['需要硬件结论时','DCGM 不替代现场诊断，也不直接作为 RMA 结论；按设备厂商要求取得并运行相应工具。']],table:{title:'诊断级别',head:['级别','范围'],rows:[['1 · 短','软件与基础环境'],['2 · 中','增加 PCIe / NVLink、显存和带宽检查'],['3 · 长','增加诊断、负载与功耗等测试'],['4 · 扩展','增加显存压力与脉冲功耗测试'] ]},commands:[{title:'指定 GPU · Linux 示例',code:'dcgmi diag -r 1 -i 0 -j',note:'0 为示例 GPU ID；核对目标后替换。-j 输出 JSON。升级测试级别前确认维护条件。'}]},
 {id:'reset',group:'进一步检查',title:'GPU 复位条件',sub:'架构、虚拟化与 NVSwitch',scope:'复位会中断目标设备的使用。Linux 需要 root，并停止 CUDA、图形和监控进程的占用。',refs:['smi','triage'],related:['154'],next:['collect','health'],steps:[
 ['确定目标与范围','按 UUID 或 PCI 地址核对目标 GPU，并保存日志。省略 -i 会复位所有 GPU。'],
 ['核对平台条件','下表用于区分平台。虚拟机还需核对直通／vGPU 模式及管理程序权限。'],
 ['恢复后复查','检查 GPU 健康及应用恢复情况。复位不保证成功；仍不健康时按平台指引进行后续恢复。']],table:{title:'平台条件',head:['平台','范围与条件'],rows:[['Ampere+ · 直连 NVLink','裸机可单卡复位；更早架构可能需要关联 GPU 一起复位。'],['Ampere · NVSwitch','FM 运行时可单卡复位；未运行时不支持单卡复位，需复位全部 NVLink 互连的 GPU 与 NVSwitch。'],['Hopper+ · NVSwitch','单卡复位不再依赖 FM。'],['虚拟机','Node Triage 中 Ampere 对应 VM 需重启；Hopper+ 取决于管理程序权限。MIG vGPU 客户机不支持 GPU reset。']]},note:'共享 NVSwitch 虚拟化还涉及服务 VM 与 FM 的协调。权限不足或平台不支持时，先采用对应平台的恢复流程。'},
 {id:'health',group:'进一步检查',title:'配置与运行指标',sub:'数量、链路、温度与功耗',scope:'将异常值与同配置的正常状态比较，结合运行负载判断。',refs:['best'],related:[],next:['network','performance','collect'],steps:[
 ['配置一致性','核对 GPU 数量、驱动、VBIOS 与 PCIe 链路；NVSwitch 平台补充 Fabric Manager 及拓扑状态。'],
 ['运行趋势','查看温度、功耗、时钟与风扇变化。记录异常发生时的负载，确认是否存在热限制或功耗限制。'],
 ['形成对照','同时保存正常与异常时段的数据。单次快照不足以解释波动，必要时连续采集再比较。']]}
];
export function manualMatches(t,query){return JSON.stringify([t,...(t.extracts||t.branches?.map(b=>b.code)||[]).map(k=>data.cn.codes[k])]).toLowerCase().includes(query.trim().toLowerCase())}
