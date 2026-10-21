# X6 集成静态管理台的样式和监听边界

## 画布有数据但截图空白

管理台全局 `svg` 规则用于图标，固定宽高为 1.25rem。X6 的根 SVG 同样命中该规则，即使设置 width/height 属性为 100%，实际只有 20px 并裁剪节点。另一个全局 `body { min-height:100dvh; min-width:320px }` 规则命中 HTML 节点的 foreignObject body，使每个节点内部内容拥有整屏最小高度。

定位时分别检查 `.x6-graph-svg`、foreignObject 和节点内容的 `getBoundingClientRect()`，不能仅凭 DOM 中存在结果或 API 返回成功判断画布可见。

解决方式只作用于工作流：根 SVG 恢复 100% 宽高并取消图标继承的 stroke；foreignObject body 清除页面 min-width/min-height。主页面和原有工具样式保持不变。真实浏览器回归脚本检查根 SVG 宽度、节点内容高度与模型尺寸乘缩放比例的一致性。

## 端口圆心与逐线暂停（2026-10-21）

X6 默认 `connecting.anchor='center'`，但 `connectionPoint='boundary'` 会再次把端点截到 magnet 外边界，所以“锚点为中心”不等于“线连到圆心”。本次两端偏差约 2.55px，缩放 0.36456，恰好等于端口半径与半描边之和乘缩放。明确设置 `anchor:'center'`、`connectionPoint:'anchor'` 后两端偏差降到约 0.00004px；不要添加固定像素补偿，否则缩放或端口尺寸变化时会再次偏离。

“选中停止流向”是本次新增交互，不是需要反向修复的动画故障。逐线暂停应使用独立播放状态，不能暂停整个画布的 SVG 时钟。流光保留原有形状，改用 CSS `offset-path:url(#实际路径)` 与 `offset-distance` 路径动画；选中类仅将对应动画的 `animation-play-state` 设为 paused，取消后恢复，其余连线持续。减少动效/隐藏状态用拥有的流光类统一暂停与隐藏，不控制节点的其他 SVG 动画。

回归不能只在未选中时验证“光点移动”，应同时验证选中时间和位置稳定、未选中继续、多选分别暂停、取消后从原进度继续，以及新线/恢复线/节点拖动和缩放后都与端口圆心重合。CSSAnimation 在菜单从 display:none 返回时可能处于 pending，playState 已为 running 但 currentTime 暂为 0，应等待 animation.ready 后再测时钟推进；位置采样先归一到路径坐标，避免字体或页面布局变化造成屏幕整体位移被误判为光点继续流动。

## SVG 连线焦点出现矩形外框

给 SVG path 增加 tabindex 后，某些聚焦方式会匹配 `:focus` 而不匹配 `:focus-visible`。只在后者清除 outline 时，浏览器仍可能绘制 path 包围盒的原生矩形轮廓，遮盖真正的曲线选中反馈。

本次截图发现该外框，实际 activeElement 为 `.wf-edge-hit` path，`:focus-visible` 为 false，但 computed outline 为 `auto 5px`。解决方式是在工作流命中路径的 `:focus` 与 `:focus-visible` 都清除原生外框，并保留清晰的曲线描边/光晕与 aria-pressed，不能全局去掉焦点反馈。浏览器回归验证聚焦确实选中线、outline 为 none、键盘删除及撤销仍正常。

鼠标聚焦与 X6 Selection 的 mouseup 也要分离：指针触发的 focus 不提前修改选择，键盘聚焦才主动选中，避免 Ctrl 点击被重复切换。

## 编辑器临时文件导致静态监听退出

广泛监听 `../public/**/*` 时，Nest CLI 会监听目录。原子编辑过程中产生 `workflow.css.tmp.<pid>.<random>`，监听器准备复制时文件已经被重命名或删除，出现 `ENOENT copyfile` 并退出，虽然业务编译没有错误。

已将 assets include 限定为实际部署资源的后缀，并排除 `.tmp.*`，启动时只订阅匹配的资源文件，避免目录监听捕获短命临时文件。已有资源文件修改继续热更新；新增文件后需要重新构建或重新启动监听，使新文件进入清单。启动配置回归检查真实 CSS/JS/HTML/图片/字体被包含，而目录和原子临时文件不匹配。

此故障与并行 build 清理 dist 引起的缺失模块不同，后者见 [并行构建与开发监听争用 dist](./2026-10-20-concurrent-build-watch-output.md)。两者都需先读取具体错误，再决定处理方式，不应盲目重启或修改业务代码。
