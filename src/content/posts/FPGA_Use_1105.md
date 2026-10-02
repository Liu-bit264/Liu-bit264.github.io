---
title: "FPGA使用"
pubDatetime: 2025-11-26T17:09:58+08:00
description: "在Quartus II中，我们通过以下步骤来编译FPGA项目并将其下载到开发板："
category: "FPGA"
tags:
  - FPGA
---

---

## FPGA项目的编译及下载

在`Quartus II`中，我们通过以下步骤来编译FPGA项目并将其下载到开发板：

1.  锁定引脚    在`Quartus II`中绘制原理图并完成仿真、确认功能可用后，在`Assignments>Pin_Planner`中根据附录中的引脚定义图锁定相关引脚
2.  编译并下载    在`Quartus II`右上角工具栏中选择`Programmer`，在`Programmer>Hardware Setup`的窗口中选择`USB Blaster`，然后`Close`。退回`Programmer`点击`Start`，等待右上角完成

---

## 注意：关于部分情况下异常报错或下载失败

1.  若在下载过程中`Progress`中出现`Failed`字样，请检查`USB Blaster`的连接和FPGA开发板的电源

---

#### Writen at 11/05
