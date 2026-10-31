# dsh-local-rag

给 DSH 一个**能翻旧账的本地记忆**。纯 Node 内置 `node:sqlite` + FTS5，零外部依赖、不联网、不要 API key。

## 它解决什么

DSH 的会话是散落在磁盘上的 zstd 文件。会话一关，模型就看不见了 —— 上周讨论过的方案、三天前定下的结论，都得你重新讲一遍。

这个 MCP 服务把这些文件（加上你的工作区文档、技能库、人设文件）切成块建全文索引，让模型能用一句话把旧事翻出来。

**中文能搜到**是这里最花心思的地方：SQLite 自带的 `unicode61` 分词器不切中文，`检索` 和 `记忆` 这种词进去等于没索引。所以入库前先切成 bigram（双字），检索时同样切，再按来源加权。

## 它提供 4 个工具

| 工具 | 干什么 |
|---|---|
| `rag_search` | 全文检索，返回带来源、标题、片段的条目。`top_k` 默认 6、最大 30；`source` 可限定 `session` / `doc` / `skill` / `persona` |
| `rag_open` | 取某条结果的相邻片段（前后各 N 块），用来看完整上下文 |
| `rag_index` | 增量重建（只处理改动过的文件）；可只重建某一类来源 |
| `rag_stats` | 索引状态：总块数、文本量、各类来源分布、上次构建时间 |

## 语料来源

| id | 内容 | 默认 |
|---|---|---|
| `session` | `~/.dsh/sessions/**/session.v4.jsonl.zstd` —— 你所有的会话 | 开 |
| `doc` | 你自己指定的工作区目录 | **要配** |
| `skill` | `~/.dsh/skills` 技能库 | 开 |
| `persona` | `~/.dsh/persona-cards`、`soul.md`、`memory` | 开 |

`doc` 源这样配（二选一）：

```bash
# 环境变量，多个用系统路径分隔符（Windows 是 ;，Linux/macOS 是 :）
export DSH_RAG_DOCS="D:/proj;D:/notes"
```

```json
// ~/.dsh/rag/config.json
{ "docs": ["D:/proj", "D:/notes"] }
```

不配也不会报错，只是不索引工作区文档。

## 检索权重

命中分数按来源加权 —— 记住"她说过什么"比记住某段代码更值钱：

| source | 权重 |
|---|---|
| persona | 1.6 |
| session | 1.45 |
| doc | 0.75 |
| skill | 0.6 |

## 装

1. 把仓库放进 `~/.dsh/rag`（或者任何地方，路径写进下面的配置）：

```bash
git clone https://github.com/fanfan14543/dsh-local-rag.git ~/.dsh/rag
```

2. 建索引（全量第一次会慢一点，之后都是增量的）：

```bash
cd ~/.dsh/rag
node --no-warnings build.js
```

3. 在 DSH 的 profile 的 `cordis.patch.yml` 里挂成 MCP server：

```yaml
- id: mcp-rag
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    servers:
      rag:
        command: node
        args:
          - "--no-warnings"
          - "C:/Users/<你>/.dsh/rag/server.js"
```

改完重启 DSH，MCP 页里就会出现 `rag_search` / `rag_open` / `rag_index` / `rag_stats`。

## 实测规模

一台用了两个多月的机器上：133 个会话 + 若干工作区文档 → **39,121 块 / 33MB 文本 / 165MB 库**，全量重建 **4.5 秒**，增量重建通常几百毫秒。

## 几个实话

- **只用 Node 自带的 `node:sqlite`**，所以要 **Node 22+**（DSH 自带的就是）。
- **不联网，也不调模型**。纯 FTS5 + BM25，检索质量靠分词和权重，不靠 embedding。想要语义检索得自己接向量库。
- **索引是本地文件**，别提交进 git（`.gitignore` 里已经排掉了）。
- 会话文件里的**思考过程、工具调用参数**会被过滤掉，只留正文，不然索引里全是噪音。

## License

MIT
