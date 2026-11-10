# 启动与数据接入

## 环境分层

| 用途 | 环境 |
| --- | --- |
| 浏览场景、程序化建模、GLB 导出 | Python 3.10+；支持 WebGL2 的桌面浏览器 |
| 影像 / DSM 面元构建 | 同一 Python 环境安装根目录 requirements.txt |
| 回归测试 | Python 3.10+、Node.js 24；无需 GPU 或模型权重 |
| 材质 Agent 生成 | Python 3.10 的独立环境、适配 GPU 的 PyTorch、模型权重和相关服务凭证 |

服务器和示例生成器只使用 Python 标准库，前端依赖已包含在 vendor/，无需 npm 安装或构建。

## 先运行演示

从仓库根目录运行 README 中的启动命令。create_demo.py 会在 data/library 中创建一个明确标为 Synthetic 的 12 栋建筑示例。示例是程序生成的几何与颜色，不对应真实城市，没有照片证据或评测分数。重复运行不会覆盖已存在文件；可通过 --output 指定另一个目录。

不生成示例也能启动系统：场景和材质列表呈现空态，程序化建模可使用纯色立面。

## 自有模型

~~~text
data/library/
├── models.json
├── models/
│   ├── my_scene.splat
│   └── my_scene.buildings.json
└── previews/
    └── my_scene.png
~~~

.splat 使用 32 字节记录：位置 float32×3、尺度 float32×3、RGBA uint8×4、旋转 uint8×4。无需登记也会发现模型；登记文件可补充标题、描述、预览和已有指标：

~~~json
{
  "items": [{
    "file": "my_scene.splat",
    "title": "我的城市片区",
    "desc": "数据来源与处理说明",
    "preview": "my_scene.png",
    "metrics": ""
  }]
}
~~~

建筑附属 JSON 的最小示例：

~~~json
{
  "aligned": true,
  "coord_system": "model local coordinates, Z up, meters",
  "buildings": [{
    "id": 0,
    "ring": [[0,0],[10,0],[10,8],[0,8],[0,0]],
    "cx": 5, "cy": 4,
    "base": 0, "top": 12,
    "height_m": 12,
    "floors": 4, "floors_est": true,
    "area_m2": 80, "perim_m": 36
  }]
}
~~~

坐标需与模型处于同一空间。aligned 表示已经对齐，不执行额外贴地偏移；floors_est 用于区分估算层数。

## 影像上传

安装根目录 requirements.txt 后，在顶部“上传影像”中选择 JPG、PNG、WebP、TIF 或 IMG，可附加 DSM GeoTIFF。无地理参考的影像需要提供实际场景宽度。当前实现支持有界上传、格式检查、任务进度、取消和结果预览。

- 有 DSM：结合地形与高程构建地表、屋顶和立面面元，并提取建筑轮廓。
- 无 DSM：构建平坦的影像地表，不推断真实建筑高度。
- 此流程没有执行 SfM 或光度 3DGS 优化。界面明确区分它与外接远端训练流程。

单文件上限为 500 MB。运行时目录、任务日志与导出均在 data/，不进入 Git。

## 材质 Agent

源码位于 material_agent/agent，包含取证、立面校正、提示词构建、候选生成、评价、修订和报告。权重及 API 凭证不随源码分发。

1. 准备独立的 Python 3.10 环境，按 GPU 配置 PyTorch；material_agent/requirements.txt 保留该模块使用的依赖版本。
2. 将 material_agent/config.example.json 复制为同目录 config.local.json，按实际文件位置补充 sd_dir、cn_canny、cn_depth、ipa_dir；也可设置 TWIN_MODELS_DIR 指向模型根目录。
3. 用环境变量设置 TENCENT_KEY / AMAP_KEY / MAPILLARY_TOKEN / GLM_KEY，根据选用的数据源配置所需项。不要提交真实凭证。
4. 从仓库根目录、使用该环境的 Python 启动 server.py，使服务与 Agent 共用已准备的环境。也可进入 material_agent 运行 python -m agent --help 查看独立 CLI。

初始页面展示正常生成入口，点击运行才检查依赖。真实生成受 GPU、权重、服务配额与影像来源可用性影响。

## 配置与部署

.env.example 是配置字段参考，不会被自动读取。通过系统或当前终端导出环境变量：

| 变量 | 默认 / 用途 |
| --- | --- |
| TWIN_HOST / TWIN_PORT | 127.0.0.1 / 8090 |
| TWIN_WEB3D | 仓库内 data/library |
| TWIN_AGENT | 仓库内 material_agent |
| TWIN_FINA | data/fina，已有兼容成果包可通过此位置接入 |
| TWIN_USE_FINA | 0 表示忽略成果包，使用普通模型库 |
| TWIN_RECON_MODE | auto；可选 local / remote |
| TWIN_LEGACY | 外接重建服务地址，默认 http://127.0.0.1:8080 |
| TWIN_REMOTE_HOST / TWIN_REMOTE_PORT | 外接重建主机，默认 127.0.0.1 / 22 |
| TWIN_MODELS_DIR | 材质模型根目录，默认 material_agent/models |

远端重建适配器兼容既有 web3d 服务协议；远端训练实现不在本仓库中。默认仅监听回环地址。本服务没有多用户身份认证、租户隔离或作业配额，不应直接暴露到公网；共享部署需由受控网关提供认证和资源限制。

按 Ctrl+C 结束前台服务。Windows 可使用 start_studio.bat；macOS/Linux 可运行 sh start_studio.sh。
