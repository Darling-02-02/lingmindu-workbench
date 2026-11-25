---
name: 今日计划
description: 【今日计划】读/改工作台的每日计划（每天固定时间的固定计划 + 自己的项目），并把某条计划绑定到 dsh 工作区。触发词：「今日计划」「今天要做什么」「加一条计划」「把这件计划交给某个工作区」「计划完成」。
---

# 今日计划

工作台的「今日计划」面板、命令行、这个 skill 是**同一份数据**——都在：

```
D:\AAAlingmindu_wb\引擎数据\.dsh\场景记忆\_共享记忆\每日计划.json
```

面板写盘时会自动把清单镜像成给人/给模型读的 markdown，两处内容一样：

```
D:\AAAlingmindu_wb\工作区\今日计划.md
D:\AAAlingmindu_wb\引擎数据\.dsh\场景记忆\_共享记忆\今日计划.md
```

## 1. 先读，不要凭记忆答

```powershell
node D:\AAAlingmindu_wb\工具\每日计划.mjs            # 今天该做的（带星期、类型、备注）
node D:\AAAlingmindu_wb\工具\每日计划.mjs --week      # 未来 7 天排布
node D:\AAAlingmindu_wb\工具\每日计划.mjs --json      # 机器可读
```

只想知道「现在该干什么」，读 `工作区\今日计划.md` 的「## 今天」那一节就够了。

## 2. 加 / 勾 / 删

```powershell
node 工具\每日计划.mjs --add "把背景图换成深海" --time 20:00 --days 1,3,5 --kind routine
node 工具\每日计划.mjs --add "写完第三章" --kind project --due 2026-12-05
node 工具\每日计划.mjs --add "只做一次的事" --kind once --time 14:00
node 工具\每日计划.mjs --done p4            # 今天标记完成（会留 logs 记录）
node 工具\每日计划.mjs --undone p4          # 撤销
node 工具\每日计划.mjs --remove p4          # 删掉（写盘前自动备份 .bak-plan-*）
node 工具\每日计划.mjs --check              # 只校验格式
```

字段含义：

| 字段 | 说明 |
|---|---|
| `time` | `HH:MM`，留空 = 不限时间（项目类一般留空） |
| `days` | `1`=周一 … `7`=周日，逗号分隔；**留空 = 每天** |
| `kind` | `routine` 固定计划（按星期出现）/ `project` 自己的项目（没勾完就一直出现）/ `once` 一次性 |
| `due` | `YYYY-MM-DD`，只有 `project` 有意义，面板会算「还剩 N 天 / 逾期 N 天」 |
| `workspace` | **dsh 工作区 id**，见第 3 节；空 = 不指定 |
| `logs` | `{"2026-11-25": {"done": true, "at": "..."}}`，勾选记录，别手写 |

## 3. 把一条计划交给某个工作区（联动）

先拿到工作区 id（就是 dsh 侧边栏里的那些工作区）：

```powershell
node 工具\每日计划.mjs --ws list     # 标题 / 路径 / 会话数 / id
# 或者直接读表
node -e "const j=require('D:/AAAlingmindu_wb/引擎数据/.dsh/storages/workspace.json');for(const id of j.global.workspaceIds){const w=j.tables.workspaces[id];console.log(w.title,'|',w.path,'|',id)}"
```

绑定：

```powershell
node 工具\每日计划.mjs --add "重构记忆同步" --kind project --ws 8f31d8d9-883f-4b8d-86cb-4f048fe3efd7
```

绑好之后：

- 工作台「今日计划」面板每一行会显示工作区名字，右边 `▶` 一点 = 在**那个工作区**新建一个会话并把标题改成「计划 · <标题>」（走 `session/create` + `session/rename`）。
- 镜像 md 的「工作区对照」把 id ↔ 标题 ↔ 路径列全，dsh 侧一眼能对上是哪个目录。

## 4. 干完了怎么办

1. 在这条计划对应的工作区里干活 → 干完 `node 工具\每日计划.mjs --done <id>`。
2. 结论写回 `引擎数据\.dsh\场景记忆\<场景>\场景私有记忆.md` 的 §〇（这是场景记忆，不是计划）。
3. 有跨场景的事：`node 工具\发消息.mjs --to <场景目录> "内容"`。

## 5. 坑

- 面板和命令行都会写盘，**别用编辑器直接改 JSON**（面板会覆盖），改完跑一次 `--check`。
- `--days` 留空等于「每天」，不是「只有今天」；只想今天做一次用 `--kind once`。
- 计划里存的 `workspace` 是 **workspaceId**，不是路径；工作区被删了面板会标「工作区已失效」。
- 写盘会自动刷 `工作区\今日计划.md`；如果 md 和 json 不一致，跑一次 `--undone`/`--done` 或面板点 ↻ 重新生成。
