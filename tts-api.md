# IndexTTS 2.0 HTTP API

版本：2.0.0  

OpenAPI 交互文档：服务启动后访问 `{base}/docs`（Swagger UI）。

---

## 两种部署方式（请先确认你跑的是哪一种）

| 方式 | 入口应用 | 说明 |
|------|----------|------|
| **队列模式（推荐生产）** | `api.gateway_main:app` | 由 `python api_server.py` 拉起：**1 个网关** + **N 个 GPU Worker** + **Redis 队列**。网关**不加载**推理模型；`/tts`、`/tts_v2` **先入队**再合成。 |
| **单体模式（兼容/开发）** | `api.main:app` | `uvicorn api.main:app`：单进程内直接加载模型，**同步**返回 WAV；并包含 **`/speakers`、`/upload_audio`、`/tts_stream`** 等完整路由。 |

默认基址：`http://localhost:8002`（下文记为 `{base}`）。若你同时开两个进程（例如网关 8002、单体 8003），请各自替换 `{base}`。

---

## 启动与基址

### 队列模式（Redis + 网关 + 多 GPU Worker）

**依赖**：本机或远端可访问的 **Redis**（默认 `redis://127.0.0.1:6379/0`）。

```bash
# 项目根目录；会启动网关 + N 个 Worker（GPU 0～N-1）
python api_server.py --gpus 4 --host 0.0.0.0 --port 8002 \
  --redis-url redis://127.0.0.1:6379/0 \
  --queue-name indextts:tts:jobs \
  --request-queue-name indextts:tts:requests \
  --job-ttl-seconds 43200 \
  --max-request-size 200
```

| 参数 | 说明 |
|------|------|
| `--gpus` | `1`～`4`，物理 GPU 数量，每张卡起一个 Worker |
| `--host` / `--port` | **仅网关**监听地址与端口 |
| `--redis-url` | Redis 连接串；同时会写入网关环境变量 `INDEX_TTS_REDIS_URL` |
| `--queue-name` | 任务队列名（`INDEX_TTS_QUEUE_NAME`） |
| `--request-queue-name` | 请求队列名（`INDEX_TTS_REQUEST_QUEUE_NAME`，Redis ZSet） |
| `--job-ttl-seconds` | 任务状态与结果在 Redis 中的保留时间（`INDEX_TTS_JOB_TTL_SECONDS`） |
| `--max-request-size` | 最大活跃请求数（达到上限后拒绝新请求） |
| `--max-queue-size` | **兼容参数（已废弃）**，等同 `--max-request-size` |

**环境变量**（网关与 Worker；使用 `python api_server.py` 时会按上表参数写入子进程环境，也可手动导出）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `INDEX_TTS_REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis 连接串 |
| `INDEX_TTS_QUEUE_NAME` | `indextts:tts:jobs` | 任务队列名（Redis List） |
| `INDEX_TTS_REQUEST_QUEUE_NAME` | `indextts:tts:requests` | 请求队列名（Redis ZSet） |
| `INDEX_TTS_JOB_TTL_SECONDS` | `43200`（12 小时） | 任务状态与合成结果在 Redis 中的保留秒数；批量或长排队场景可再调大 |
| `INDEX_TTS_MAX_REQUEST_SIZE` | `200` | 最大活跃请求数（统计 queued/processing 请求） |
| `INDEX_TTS_MAX_QUEUE_SIZE` | `200` | 兼容旧变量；未设置 `INDEX_TTS_MAX_REQUEST_SIZE` 时回退使用 |

也可只启网关或只启 Worker（进阶运维场景）：

```bash
uv run uvicorn api.gateway_main:app --host 0.0.0.0 --port 8002
# 另开终端，每卡一条（示例：GPU 0）
CUDA_VISIBLE_DEVICES=0 uv run python api_worker.py --gpu-id 0 --redis-url redis://127.0.0.1:6379/0
```

**说明**：队列模式下 **没有** `/speakers`、`/upload_audio`、`/tts_stream`；音色管理与上传需使用 **单体模式** 另起服务，或后续在网关侧合并路由。

### 单体模式（单进程含模型 + 全路由）

```bash
uvicorn api.main:app --host 0.0.0.0 --port 8002
```

未设置环境变量 `CUDA_VISIBLE_DEVICES` 时，`api/main.py` 会默认使用可见 GPU `0`（仅影响**本进程**绑卡）。

### 数据库迁移（Alembic）

**适用**：SQLite 音色库；与 **`/speakers`**、**`/upload_audio`** 等（**单体模式**）配合使用。

音色库使用 SQLite（默认路径：`assets/speakers/voices.db`）。项目已配置 **Alembic**，请在**项目根目录**使用：

```bash
uv run alembic upgrade head    # 新库建表
uv run alembic current         # 查看当前版本
```

- **不要**执行 `python alembic/env.py`；应使用 **`uv run alembic`**（或激活 venv 后的 `alembic`）。
- 若库表已由旧版 `create_all` 建好，请先阅读 `alembic/README` 中的 **`alembic stamp`** 说明，避免重复建表报错。
- 连接串可通过 `ALEMBIC_DATABASE_URL` / `INDEX_TTS_VOICE_DATABASE_URL` 覆盖，详见 `alembic/README`。

### 公网试听链接（`audio_url`）

列表/详情里的 **`audio_url`** 默认按**当前请求的 Host** 生成；本机访问时常为 `http://127.0.0.1:8002/...`，**不适合直接发给他人使用**。

- 部署到公网时，请设置环境变量 **`INDEX_TTS_PUBLIC_BASE_URL`**（例如 `https://tts.example.com`，不要尾随 `/`）。设置后 `audio_url` 会变为 `{INDEX_TTS_PUBLIC_BASE_URL}/speakers/{voice_id}/audio`。
- 响应中的 **`audio_path`** 为相对路径（如 `/speakers/xxx/audio`），前端也可用 **`你的站点公网 origin + audio_path`** 自行拼接。

**说明**：数据库中的 **`file_name`** 表示磁盘上的真实文件名；下载接口路径使用 **`voice_id`**，服务端根据 `voice_id` 查库得到 `file_name` 再读文件，因此 **URL 里不必、也不会**出现 `file_name` 片段。

---

## 通用约定

### 音色与参考音频

- **`id`**：数据库自增主键（`VoiceInfo.id`）。
- **`voice_id`**：业务唯一键，与提示音频文件名（不含扩展名）一致；例如文件 `Bill.mp3` 对应 `voice_id=Bill`。
- **参考音频目录**：默认 `assets/speakers/`（响应里 `directory` 字段会返回实际路径）。
- **音色元数据存储**：该目录下的 `voices.db`（SQLite），由 SQLAlchemy 访问。

### TTS 请求中的音色

以下字段**二选一必填**（若都缺省则返回 400）：

- **`prompt_speech_path`**：参考音频文件名或路径；非绝对路径时按 `assets/speakers/` 下的文件名解析。
- **`speaker`**：音色 ID（即 `voice_id`），在目录或数据库中解析对应文件。

### TTS 幂等重试（`client_request_id`）

`/tts` 与 `/tts_v2` 请求体支持可选字段 **`client_request_id`**（建议由客户端为每条业务请求生成唯一值）。

- 同一 `client_request_id` + 同一请求参数重复提交时，服务端会**复用已有请求**，不再重复入队。
- 若同一 `client_request_id` 但请求参数不同，返回 `409`（冲突）。
- 对于重试请求：
  - 若已有请求已完成，接口可直接返回历史音频；
  - 若仍在队列中，返回 `202` 并带已有 `request_id`（客户端统一查询 `/requests/{request_id}`）。
- **未带 `client_request_id` 时**：每次 `POST` 都是一次新的业务提交，会生成**新的** `request_id`，与是否使用相同 `text` 无关。

### 队列网关：curl 与 JSON 注意事项

- **JSON 字符串内不能出现裸换行等未转义控制字符**。在 shell 里用 `-d '{...}'` 写多行正文时，若直接在 `"text":"..."` 里换行，会导致 **`422`**，错误类似 `Invalid control character`。  
  - 换行请写成 **`\n`**；或把合法 JSON 写入文件，使用 **`curl -H "Content-Type: application/json" -d @body.json`**（长文本推荐）。
- **响应体可能是 WAV，也可能是 JSON**：
  - **`200`** + `Content-Type: audio/wav`：在 `wait_timeout_seconds` 内已合成完成，**响应体为二进制**，不要用 `python -m json.tool` 解析。
  - **`202`** + JSON：等待超时或仍在排队，**`detail` 中含 `request_id`**，再轮询 `GET /requests/{request_id}`。
- 用 **`| head -c N`** 截断输出时，若响应为 WAV，`head` 会提前关闭管道，可能出现 **`curl: (23) Failure writing output to destination`**，属管道问题而非服务端错误。调试时请 **`curl -o out.wav`** 或先看响应头 **`Content-Type`**。

### 内容类型

| 接口 | Content-Type |
|------|----------------|
| `/tts`、`/tts_v2`、`/v1/audio/speech`、`/tts_stream`、`POST /speakers`、`PATCH /speakers/{voice_id}` | `application/json` |
| `/upload_audio` | `multipart/form-data`（**必须**包含 `source_file` 及 `voice_id`、`name`、`description`、`language`、`gender`） |

仅录入元数据、不上传文件时，请使用 **`POST /speakers`**（JSON），不要使用无文件的 `multipart` 调用 `/upload_audio`。

---

## 端点一览

### 队列网关（`api.gateway_main` / `python api_server.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 网关信息与端点列表 |
| POST | `/v1/audio/speech` | OpenAI Speech 兼容接口（`model/voice/input/response_format`） |
| POST | `/tts` | 基础 TTS：入 Redis 队列；长文本自动分段并发 |
| POST | `/tts_v2` | 增强 TTS：同上（**推荐**） |
| GET | `/jobs/{job_id}` | 查询单任务状态 |
| GET | `/jobs/{job_id}/audio` | 单任务完成后取 WAV |
| GET | `/jobs/group/{group_id}` | 查询分段组整体状态（含各子任务进度） |
| GET | `/jobs/group/{group_id}/audio` | 分段组全部完成后取**合并** WAV |
| GET | `/requests/{request_id}` | 统一查询请求状态（推荐客户端使用） |
| GET | `/requests/{request_id}/audio` | 请求完成后统一取音频（推荐客户端使用） |
| GET | `/queue/status` | 当前队列深度、请求容量与自动分段参数 |
| GET | `/queue/progress` | 队列进度聚合视图（任务状态计数、processing 按 GPU 分布、可选分段组摘要） |

#### 常用查询命令（队列模式）

> 下列示例假设 `{base}=http://127.0.0.1:8002`。Redis 参数优先使用环境变量：`INDEX_TTS_REDIS_URL`、`INDEX_TTS_QUEUE_NAME`、`INDEX_TTS_REQUEST_QUEUE_NAME`。

**HTTP 查询**

```bash
# 队列深度/容量
curl -s "${base}/queue/status" | jq

# 任务状态聚合（queued/processing/done/failed 统计 + 分段组摘要）
curl -s "${base}/queue/progress?include_groups=true&max_group_items=20" | jq

# 查询单任务状态
curl -s "${base}/jobs/<job_id>" | jq
```

**Redis 直查（不依赖网关进程）**

```bash
# 查看队列长度（待消费消息数）
redis-cli -u "$INDEX_TTS_REDIS_URL" LLEN "${INDEX_TTS_QUEUE_NAME:-indextts:tts:jobs}"

# 查看队列前几条（确认是否堆积；消息为 JSON bytes）
redis-cli -u "$INDEX_TTS_REDIS_URL" LRANGE "${INDEX_TTS_QUEUE_NAME:-indextts:tts:jobs}" 0 5

# 查看某个 job 的状态 hash
redis-cli -u "$INDEX_TTS_REDIS_URL" HGETALL "indextts:tts:job:<job_id>"

# 查看请求队列深度（活跃请求队列，ZSet）
redis-cli -u "$INDEX_TTS_REDIS_URL" ZCARD "${INDEX_TTS_REQUEST_QUEUE_NAME:-indextts:tts:requests}"
```

**Redis 健康检测（快速排障）**

```bash
# 1) 进程与监听端口（本机默认 6379）
ss -ltnp | grep 6379

# 2) 本机可达性（应返回 PONG）
redis-cli -h 127.0.0.1 -p 6379 ping

# 3) 若使用 redis-url，直接按 URL 探活（推荐）
redis-cli -u "${INDEX_TTS_REDIS_URL:-redis://127.0.0.1:6379/0}" ping

# 4) 服务端基础自检（可选）
redis-cli -u "${INDEX_TTS_REDIS_URL:-redis://127.0.0.1:6379/0}" INFO server | head -n 20
```

判定建议：
- `PONG` 且 `GET /queue/status` 返回 `200`：Redis 与网关连通正常。
- 出现 `Connection refused`：Redis 未启动、未监听目标地址，或 `--redis-url` 指向错误地址/端口。
- 本机 `redis-cli ping` 正常但网关仍报错：优先检查网关启动参数 `--redis-url` 与环境变量 `INDEX_TTS_REDIS_URL` 是否一致。

### 单体 API（`api.main` / `uvicorn api.main:app`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息与端点列表 |
| GET | `/speakers` | 音色列表（筛选、排序、分页；含 `audio_url`） |
| POST | `/speakers` | 仅创建音色元数据（JSON） |
| PATCH | `/speakers/{voice_id}` | 更新音色元数据 |
| GET | `/speakers/{voice_id}/audio` | 试听/下载参考原音频 |
| POST | `/tts` | 基础 TTS，**进程内直接合成**，响应 `audio/wav` |
| POST | `/tts_v2` | 增强 TTS，同上 |
| POST | `/v1/audio/speech` | OpenAI Speech 兼容接口（`model/voice/input/response_format`） |
| POST | `/tts_stream` | 流式 TTS（NDJSON） |
| POST | `/upload_audio` | 上传参考音频并写入音色库 |

---

## GET `/`

- **队列网关**：返回 `mode: "gateway"`，并列出入队、任务查询相关路径。
- **单体 API**：返回 `message`、`version`、`endpoints` 说明列表（含 speakers、upload、stream 等）。

---

## GET `/speakers`

**适用**：仅 **单体模式**（`api.main`）。队列网关无此路由。

返回音色分页列表，并与磁盘上的 `wav`/`mp3` 做一次同步（扫描目录写入/更新库）。

### 查询参数

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `language` | string | 无 | 按列 `language` **精确**匹配 |
| `gender` | string | 无 | 按列 `gender` **精确**匹配 |
| `category` | string | 无 | 精确匹配分类 |
| `enabled` | boolean | `true` | 是否启用；传 `false` 可查已禁用音色 |
| `search` | string | 无 | 在 `voice_id`、`name`、`description`、`language`、`gender` 中模糊匹配 |
| `label_key` | string | 无 | 存在该标签 key；若同时传 `label_value` 则 key+value 精确匹配 |
| `label_value` | string | 无 | 与 `label_key` 联用 |
| `sort_by` | string | `voice_id` | 允许：`voice_id`、`name`、`language`、`gender`、`created_at`、`updated_at`、`usage_count` |
| `sort_order` | string | `asc` | `asc` 或 `desc` |
| `page` | int | `1` | ≥1 |
| `page_size` | int | `50` | 1～200 |

### 响应体 `SpeakersListResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| `voices` | `VoiceInfo[]` | 当前页音色详情 |
| `speakers` | `string[]` | 当前页 `voice_id` 列表 |
| `count` | int | 符合筛选条件的总条数 |
| `directory` | string | 提示音目录路径 |
| `page` | int | 当前页 |
| `page_size` | int | 每页条数 |
| `message` | string? | 提示信息（例如目录不存在时） |

### `VoiceInfo`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | int | 数据库自增主键 |
| `voice_id` | string | 业务唯一键（原「文件名 stem」） |
| `name` | string | 显示名 |
| `description` | string | 描述 |
| `category` | string? | 分类 |
| `language` | string? | 语种 |
| `gender` | string? | 性别等 |
| `file_name` | string | 磁盘上的文件名 |
| `enabled` | boolean | 是否启用 |
| `owner` | string? | 所有者 |
| `version` | string? | 版本 |
| `created_at` | string? | ISO 时间 |
| `updated_at` | string? | ISO 时间 |
| `usage_count` | int | 使用次数统计 |
| `last_used_at` | string? | 最后使用时间 |
| `audio_url` | string? | 完整试听 URL；见上文 `INDEX_TTS_PUBLIC_BASE_URL` |
| `audio_path` | string? | 相对路径 `/speakers/{voice_id}/audio`，便于拼接公网地址 |

响应中**不包含** `labels`；`voice_labels` 表仍保留，创建/更新接口（如 `labels_json`、`PATCH` 的 `labels`）仍可写入，便于日后扩展。

---

## POST `/speakers`

**适用**：仅 **单体模式**（`api.main`）。

仅写入数据库中的音色元数据，**不要求**磁盘上已存在音频文件。未指定 `file_name` 时，默认 `file_name = "{voice_id}.wav"`，之后可用 **`POST /upload_audio`** 上传音频（表单中指定同一 `voice_id`，磁盘上会保存为 `{voice_id}.wav` 或 `{voice_id}.mp3`）补齐。

**请求体** `VoiceCreateRequest`（JSON）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `voice_id` | string | 是 | 音色 ID |
| `name` | string | 否 | 默认与 `voice_id` 相同 |
| `description` | string | 否 | 默认 `""` |
| `category` | string | 否 | |
| `language` | string | 否 | |
| `gender` | string | 否 | |
| `labels` | object | 否 | 字符串键值对 |
| `owner` | string | 否 | |
| `version` | string | 否 | |
| `enabled` | boolean | 否 | 默认 `true` |
| `file_name` | string | 否 | 库中记录的文件名；默认 `{voice_id}.wav` |

**响应**：`201`，body 为 `VoiceInfo`（含 `audio_url`、`audio_path`）。

---

## PATCH `/speakers/{voice_id}`

**适用**：仅 **单体模式**（`api.main`）。

部分更新音色元数据。

**路径参数**：`voice_id`

**请求体** `VoiceUpdateRequest`（JSON，字段均可选）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | |
| `description` | string | |
| `category` | string | |
| `language` | string | |
| `gender` | string | |
| `labels` | object | 传入则**整表替换**该音色标签 |
| `enabled` | boolean | |
| `owner` | string | |
| `version` | string | |

**响应**：`VoiceInfo`（含 `audio_url`）。不存在则 `404`。

---

## GET `/speakers/{voice_id}/audio`

**适用**：仅 **单体模式**（`api.main`）。

根据 **`voice_id`** 查库读取 **`file_name`**，在提示音目录下返回对应磁盘文件（**原文件**）。`Content-Disposition` 为 `inline`，便于浏览器试听。路径中**不包含** `file_name`，避免与 REST 路由冲突；实际文件名以库字段为准。

**路径参数**：`voice_id` 必须为**单一路径段**（不能含 `/`）。

**响应**：音频流；`404` 表示无此音色或文件不在允许路径下。

---

## POST `/upload_audio`

**适用**：仅 **单体模式**（`api.main`）。

将 `wav` 或 `mp3` 保存到提示音目录，并 upsert 音色记录。磁盘文件名固定为 **`{voice_id}` + 上传文件的扩展名**（例如 `voice_id=my_speaker` 且上传 `x.mp3` 则保存为 `my_speaker.mp3`）。

**Content-Type**：`multipart/form-data`

| 表单字段 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| `source_file` | file | 是 | 仅支持 `.wav` / `.mp3` |
| `voice_id` | string | 是 | 音色 ID；不能与路径分隔符等混用 |
| `name` | string | 是 | 显示名称 |
| `description` | string | 是 | 描述（可为空字符串） |
| `language` | string | 是 | 语言 |
| `gender` | string | 是 | 性别 |
| `category` | string | 否 | |
| `owner` | string | 否 | |
| `version` | string | 否 | |
| `enabled` | bool | 否 | 默认 `true` |
| `labels_json` | string | 否 | JSON 对象字符串，解析为标签 |

**成功响应示例**：

```json
{
  "status": "success",
  "message": "音频文件上传成功",
  "file_path": "/path/to/assets/speakers/xxx.mp3",
  "speaker_name": "xxx",
  "voice_id": "xxx"
}
```

缺少必填字段或未上传 `source_file` 时返回 **`422`**（校验）或 **`400`**；仅录入元数据请使用 `POST /speakers`（JSON）。

---

## POST `/tts`

**Content-Type**：`application/json`

**请求体** `TextToSpeechRequest`：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `text` | string | 是 | | 合成文本 |
| `client_request_id` | string | 否 | | 幂等键；同键同参重复提交时复用请求，见上文 |
| `prompt_speech_path` | string | 否* | | 与 `speaker` 二选一 |
| `speaker` | string | 否* | | 与 `prompt_speech_path` 二选一 |
| `temperature` | number | 否 | 0.8 | |
| `top_k` | int | 否 | 30 | |
| `top_p` | number | 否 | 0.8 | |
| `seed` | int | 否 | 421 | |
| `max_text_tokens_per_sentence` | int | 否 | 120 | 传入模型作为分段 token 上限相关 |
| `sentences_bucket_max_size` | int | 否 | 4 | |
| `max_mel_tokens` | int | 否 | 1500 | |
| `num_beams` | int | 否 | 3 | |
| `length_penalty` | number | 否 | 0.0 | |
| `repetition_penalty` | number | 否 | 10.0 | |

\* `prompt_speech_path` 与 `speaker` 至少填一个。

长文本会在 **模型内部** 按 token 分段合成后再拼接（与是否走队列无关）。

### 队列网关下的行为（`api.gateway_main`）

| 查询参数 | 类型 | 默认 | 说明 |
|----------|------|------|------|
| `wait_timeout_seconds` | int | `180` | 网关**轮询 Redis 等待结果**的最长时间（1～1800 秒）。超时则不再阻塞，见下表 |
| `auto_split` | bool | `true` | 是否对超出 `INDEX_TTS_AUTO_SPLIT_THRESHOLD` 字符的文本**自动分段并发**投队（详见下文「长文本自动分段」）|

| HTTP | 说明 |
|------|------|
| `200` | 成功，响应体为 `audio/wav` 二进制 |
| `202` | 在 `wait_timeout_seconds` 内未完成；返回 `request_id`（长文本附带 `job_ids`），按下文说明异步查询 |
| `503` | 活跃请求数已达 `max-request-size`（背压），请稍后重试 |
| `400` / `422` / `500` | 参数错误、校验失败或任务失败 |

#### 长文本自动分段（多 GPU 并发）

当文本长度超过 **`INDEX_TTS_AUTO_SPLIT_THRESHOLD`**（默认 1200 字符）且 `auto_split=true` 时：

1. 网关在 API 层将文本按 **`INDEX_TTS_AUTO_SPLIT_SEGMENT_LENGTH`**（默认 1000 字符）分割为 N 段；为避免最后只剩一两个词，实际分段可能少量超过目标长度。
2. N 个子任务**同时**投入 Redis 队列，被不同 GPU Worker **并行**处理。
3. 所有子任务完成后，网关按原始顺序合并音频（段间插入 `interval_silence` ms 静音），一次返回完整 WAV。
4. 若在 `wait_timeout_seconds` 内未全部完成，返回 **202** + `request_id`，客户端统一调用：
   - `GET /requests/{request_id}` — 查看请求状态（内部可能是单任务或分段组）
   - `GET /requests/{request_id}/audio` — 状态为 `done` 时取最终音频

**环境变量**：

| 变量 | 默认 | 说明 |
|------|------|------|
| `INDEX_TTS_AUTO_SPLIT_THRESHOLD` | `1000` | 字符数阈值；0 表示禁用自动分段 |
| `INDEX_TTS_AUTO_SPLIT_SEGMENT_LENGTH` | `1000` | 每段目标最大字符数；为避免极短尾段，实际分段可能少量超过该值 |

### 单体模式下的行为（`api.main`）

**响应**：直接 `200`，`Content-Type: audio/wav` 二进制（进程内同步推理，无 `wait_timeout_seconds`、无自动分段）。

---

## POST `/tts_v2`

**Content-Type**：`application/json`

在 `/tts` 基础上增加情感等参数。请求体 `EnhancedTTSRequest`：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `text` | string | 必填 | |
| `client_request_id` | string? | | 幂等键，同 `/tts` |
| `prompt_speech_path` / `speaker` | string | 二选一 | 同 `/tts` |
| `temperature` … `repetition_penalty` | | 同左文 | 与生成相关 |
| `do_sample` | boolean | `true` | |
| `emo_audio_prompt` | string? | | 情感参考音频路径（目录内文件名） |
| `emo_alpha` | number | 1.0 | 情感权重 |
| `emo_vector` | float[]? | | 长度 8：`[喜,怒,哀,惧,厌恶,低落,惊喜,平静]` |
| `use_emo_text` | boolean | `false` | |
| `emo_text` | string? | | 情感描述 |
| `use_random` | boolean | `false` | |
| `interval_silence` | int | 200 | 间隔静音(ms) |
| `emo_control_mode` | int | `0` | `0` 与音色参考相同；`1` 情感参考音；`2` 情感向量；`3` 情感文本 |

**队列网关**：查询参数 **`wait_timeout_seconds`** 与 **`/tts`** 相同；状态码语义与 **`/tts`** 的网关小节一致。

**单体模式**：**响应**为 `audio/wav` 二进制。

---

## POST `/v1/audio/speech`

**Content-Type**：`application/json`  
**适用**：队列网关 + 单体模式（OpenAI Speech 兼容入口）

请求体 `OpenAISpeechRequest`：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `model` | string | 是 | | 模型名（兼容字段；当前实现不参与路由分发） |
| `voice` | string | 是 | | 映射到 `speaker`（音色 ID） |
| `input` | string | 是 | | 映射到 `text` |
| `response_format` | string | 否 | `wav` | 支持 `wav` / `mp3` |

鉴权头可传 `Authorization: Bearer <apiKey>`（当前实现不会校验该字段，仅做协议兼容）。

响应：
- 成功时直接返回音频二进制：
  - `response_format=wav` → `Content-Type: audio/wav`
  - `response_format=mp3` → `Content-Type: audio/mpeg`
- 队列网关在等待超时时会返回 `202` + `request_id`（与 `/tts` 行为一致）。

---

## GET `/jobs/{job_id}`

**适用**：仅 **队列网关**。

返回 JSON 字段：`job_id`、`status`（`queued` / `processing` / `done` / `failed`）、`request_type`、`group_id`（若属于分段组）、`segment_index`、`total_segments`、`created_at`、`updated_at`、`error`。

任务过期后返回 **`404`**。

---

## GET `/jobs/{job_id}/audio`

**适用**：仅 **队列网关**。

仅当任务 `status` 为 **`done`** 时返回 `audio/wav`（单段）。未完成时 **`409`**；过期 **`404`**。

---

## GET `/jobs/group/{group_id}`

**适用**：仅 **队列网关**；长文本自动分段时使用。

返回分段组整体状态：

| 字段 | 说明 |
|------|------|
| `group_id` | 组 ID |
| `status` | `processing` / `done` / `failed` / `queued` |
| `total_segments` | 总段数 |
| `done_count` | 已完成段数 |
| `job_ids` | 各子任务 ID 列表 |
| `created_at` / `updated_at` | 时间戳 |
| `error` | 失败时的错误信息 |

---

## GET `/jobs/group/{group_id}/audio`

**适用**：仅 **队列网关**；长文本自动分段时使用。

所有子任务完成（`status=done`）后返回**按原文顺序合并**的 `audio/wav`。未完成时 **`409`**（含已完成段数提示）；过期 **`404`**。

---

## GET `/requests/{request_id}`

**适用**：仅 **队列网关**；推荐客户端统一使用该接口查询请求状态。

返回 JSON 字段：`request_id`、`status`（`queued` / `processing` / `done` / `failed`）、`request_type`、`client_request_id`、`job_id`、`group_id`、`created_at`、`updated_at`、`error`。

---

## GET `/requests/{request_id}/audio`

**适用**：仅 **队列网关**；推荐客户端统一使用该接口获取音频结果。

当 `status=done` 时返回最终 `audio/wav`：
- 单任务请求：返回对应 job 音频；
- 分段请求：返回组装后的合并音频。

未完成返回 `409`，过期返回 `404`。

---

## GET `/queue/status`

**适用**：仅 **队列网关**。

返回 JSON：`queue_name`、`queue_depth`（任务队列排队长度）、`request_queue_name`、`request_queue_depth`（请求队列深度）、`request_capacity`（最大活跃请求数）、`active_requests`（当前活跃请求数）、`request_status_counts`（请求状态计数）、`job_ttl_seconds`（任务与结果 TTL）、`auto_split_threshold`（自动分段字符阈值）、`auto_split_segment_length`（每段字符上限）。

---

## POST `/tts_stream`

**适用**：仅 **单体模式**（`api.main`）。队列网关**无**此路由。

**Content-Type**：`application/json`

按 `max_segment_length`（默认 100）对 `text` 分段，逐段合成并以 **NDJSON**（每行一个 JSON）流式返回。

请求体在 `EnhancedTTSRequest` 基础上增加：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `max_segment_length` | int | 100 | 分段最大字符数 |

**响应**：`Content-Type: application/x-ndjson`

成功时每行 JSON 包含：`text`、`audio`（样本数组）、`sample_rate`、`segment_index`、`total_segments`。

失败时该行可能包含：`error`、`segment_index`、`total_segments`、`text`。

---

## 错误与状态码

| 码 | 含义 |
|----|------|
| 400 | 参数错误（如未提供 `speaker`/`prompt_speech_path`、未上传文件等） |
| 404 | 资源不存在（音色、音频文件、已过期任务等） |
| 409 | 任务尚未完成（例如对未完成 job 请求 `/jobs/{id}/audio`） |
| 422 | JSON 无法解析为约定模型（常见：请求体字符串内含裸换行等非法控制字符） |
| 500 | 服务器内部错误或 TTS 任务失败（队列模式下失败信息可能在 `detail` 或 `GET /jobs` 的 `error`） |
| 202 | **仅队列网关**：`/tts`、`/tts_v2` 在 `wait_timeout_seconds` 内未等到完成，返回 `request_id`，需轮询 |
| 503 | **仅队列网关**：活跃请求数已达上限（背压） |

---

## 客户端调用建议（队列模式）

- **新接入**优先使用 **`POST /tts_v2`**。
- **同步拿音频**：设置合适的 **`wait_timeout_seconds`**（秒）；若队列空闲且文本较短，可能直接 **`200` + WAV**；否则 **`202` + `request_id`**。请先判断状态码与 **`Content-Type`**，再解析 JSON 或保存音频。
- **批量或长耗时**：使用较短等待时间或接受 **`202`**，统一轮询 `GET /requests/{request_id}`，完成后 `GET /requests/{request_id}/audio`。
- **幂等与重试**：对每一段/每一条业务固定 **`client_request_id`**，避免网络超时后重复提交产生多条队列任务；无该字段时每次 `POST` 都会产生新的 `request_id`。
- **JSON 正文**：长文本勿在 JSON 字符串内直接换行，使用 `\n` 或 **` -d @file.json`**，否则易触发 **422**（`Invalid control character`）。
- **并发**：Worker 数为 N 时，同时进行的合成约 N 路；HTTP 并发不宜远大于队列容量与网关承载，避免大量长连接占满资源。请求数达上限时返回 **503**，应退避重试。

---

## 与实现的对应关系

- **队列网关**：`api/gateway_main.py`、`api/routers/root_queue.py`、`api/routers/tts_queue.py`、`api/redis_queue.py`
- **GPU Worker**：`api_worker.py`（消费 Redis、调用 `api/inference`）
- **统一拉起**：`api_server.py`
- **单体 API**：`api/main.py`、`api/routers/tts.py`、`api/routers/speakers.py`、`api/routers/upload.py`
- 模型与请求体：`api/schemas.py`、`api/inference.py`
- 音色持久化：`api/services/voices.py`、`api/database/`

本文档随版本迭代时，请以代码与 `/docs` 为准。
