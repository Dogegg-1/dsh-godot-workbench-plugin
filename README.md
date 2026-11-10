# 游戏开发工作台

在 DeepSeek Harness 中规划、制作和验证 Godot 独立游戏。用卡片入口新建或接入工程，跟进开发计划、诊断和试玩反馈。

## 安装到 DSH

使用 Windows 上的 DeepSeek Harness **0.2.1-rc.2**。

1. 在 DSH 里打开「插件 → 添加插件」，粘贴下面的地址，点击「安装」和「立即启用」。

```text
https://github.com/Dogegg-1/dsh-godot-workbench-plugin/releases/download/v0.1.1/godot-workbench-0.1.1.tgz
```

2. 保存工作，完全退出并重开 DSH，然后点「游戏开发」。可以稍后在工作台内配置 Godot。

下载连不上时，可以把[安装包](https://github.com/Dogegg-1/dsh-godot-workbench-plugin/releases/download/v0.1.1/godot-workbench-0.1.1.tgz)传到这台电脑，在同一个「添加插件」窗口选择本地文件。保留文件原样即可。

<details>
<summary>发布者索引</summary>

需要订阅后续版本时，可在 DSH 启用「自定义插件索引」，把下方地址添加到「发现」。

```text
https://raw.githubusercontent.com/Dogegg-1/dsh-godot-workbench-plugin/main/index.json
```

</details>

## 开始使用

用「让 AI 帮我新建」准备新项目，或导入现有 Godot 工程。确认开发计划后再制作玩法。工程检查和你的试玩判断分别记录。

## 数据与归属

诊断和制作调用你在 DSH 中配置的模型，所选项目上下文可能发送给该模型服务。此包不包含账号、会话、存档、DSH 或 Godot。第三方归属见 [随包声明](dist/THIRD_PARTY_NOTICES.md)。当前为预览版，兼容性和体验仍在验证。
