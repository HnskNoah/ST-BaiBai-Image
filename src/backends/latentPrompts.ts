/**
 * Latent 渠道的内置规范与思维链文本(设置页「Latent 规范 / Latent 思维链」留空时的终端回落值)。
 *
 * 【为什么独立成模块】这两份原先寄居在 state/settings.ts 的 DEFAULT_NAI_SPEC /
 * DEFAULT_NAI_THINKING 里——latent 恒走单串口径,而 NAI 4.5 以下那套单串文本在模型列表
 * 收窄后已不可达,于是内容被按 latent 的现状改写、只留了上游的常量名。代价是上游每次改
 * 那两份常量,latent 就跟着变:0.3.2 往里加了 {{#nl}}/{{^nl}} 自然语言条件段宏,而 latent
 * 侧没有 expandNlSections 接线,宏会原样发给站点;两者文本高度相似还会触发 git 的重命名
 * 探测,把上游改动误配到 latent 这份上。
 *
 * 现在两个渠道各自一份:本模块归 latent,settings.ts 的 DEFAULT_NAI_* 交回上游维护
 * (NAI 遗留单串分支的回归锁)。改 NAI 渠道的规范请改 DEFAULT_NAI_V5_SPEC。
 *
 * 【刻意不带宏】latent 恒吃自然语言(traits.nlAlways,见 backends/channelTraits.ts),nl 段
 * 无条件写死在文本里,不需要条件段——少一层展开就少一处会漂的接线。
 */

/**
 * Latent 规范内置默认:与 ComfyUI 规范同构,danbooru 短 tag;质量词由后端按渠道分册自动
 * 附加,故禁写(见 backends/nai.ts 的 LATENT_DEFAULT_*)。
 *
 * 回落链的终端:latentSpec(设置页「Latent 规范」)→ naiSpec(旧 4.5 键,存量自定义不失效)
 * → 本常量。内容按消费方现状维护:底层模型为 Anima 系(站点口径,吃自然语言——tag 与 nl
 * 拼在同一串里下发),画师 tag 由用户画师串以 @名字 形式附加(AI 禁写)。
 */
export const DEFAULT_LATENT_SPEC = `【Latent 渠道提示词规范】
你输出的画面提示词会被直接发送给该站点（ Anima 系动漫模型，文本编码器为 Qwen 系）。

tag（JSON 的 tag 键）：danbooru 短 tag——英文小写、逗号分隔的关键词串，多词用空格连接（不要用下划线；唯一例外是 score_1～score_9 这类评分 tag，它们保留下划线），例如：
1girl, long hair, school uniform, window, sitting, classroom, warm sunlight
从重要到次要排列：人数/主体 → 镜头构图 → 外貌 → 服饰 → 动作姿态 → 表情视线 → 场景 → 光线氛围。
Anima 训练时做过随机 tag dropout，不要求把相关 tag 写满：优先给高信息量的词，删掉同义重复，不要为凑数堆词。
动作姿态内部再排：本画面核心动作（谁做了什么、身体部位接触了什么）必须是动作区第一条独立短 tag；辅助姿态（坐着、站着、跪着等）排后面。同一动作词不得重复写两遍。
表情与视线每张图都要写，不得省略，且必须使用模型认识的标准 danbooru 词，不得自创描述性词组（例外：画面里根本不出现脸的局部特写——只拍手、腿、脚、道具——允许省略表情与视线，硬写只会让模型给没脸的地方塞一张脸）：
- 表情从这类实际存在的 tag 里选（可叠加 1~2 个）：smile、grin、laughing、blush、embarrassed、frown、pout、puffy cheeks、surprised、crying、tears、angry、serious、sad、worried、scared、smug、seductive smile、expressionless、half-closed eyes、open mouth、clenched teeth。
- 视线选一个：looking at viewer、looking at another、looking away、looking down、looking up、looking back、closed eyes 之外不要另造。
- 禁止把思考里的中文描述直译成 tag：gentle smile 写 smile，shy expression 写 blush，neutral curious expression 这类词组在 tag 区不会按你想的方式生效，只会浪费 token 并稀释其余 tag。带形容词的自然语言感受写进 nl，tag 只放标准词。
- 正文没写表情不是不写的理由——推断一个；判断为面无表情时也要显式写 expressionless。
同人角色身份 tag：若角色明确来自已有动漫、游戏、小说等作品，必须在人数/构图之后、普通外貌之前写模型可识别的英文 Danbooru 身份 tag，实际形态为 character name \\(copyright name\\)——**括号必须转义**：站点按权重语法解析未转义圆括号，不转义它就不是身份的一部分；由于最终输出是 JSON，tag 字符串里要写成 "character name \\\\(copyright name\\\\)"，JSON 解析后才会保留单个反斜杠。角色名与作品名使用其通行英文 tag，不得直译中文、缩写作品名或只写角色名。原创角色不写；无法可靠确定作品时不得猜测，按原创角色处理。
⚠ 本规范里出现的发色、服装与单品（long silver hair、red eyes、white dress、red dress 等）全是**占位例子**：绝不许照抄进画面——画面里的发色、服装、配饰只能来自正文、设定与角色固定外貌库，照抄例子等于编造。
显式场景 tag：当正文明确是 NSFW/性行为画面时，不能只写 nsfw、nude、sex 或含蓄动作。逐个写出画面中实际可见、与动作有关的身体部位和性器官（如 breasts、nipples、penis、pussy、anus、testicles），并用准确的 Danbooru 动作/接触 tag 说明谁的什么部位接触或进入哪里；性器官被衣物、身体或镜头完全遮住时不要虚构为可见。
人数 tag 是构图的基础：人物多的画面务必写清数量 tag（1girl、2boys 等）——Anima 系对 danbooru 词表理解良好，缺了数量 tag 会漏画或多画。
画风不归你管：不得写任何画师/画风 tag（画师格式是 @名字，artist:xxx 是 NAI 官方格式——两种都不要出现），画师串由系统按用户配置以 @名字 形式附加在最前，你写了只会污染画面、挤占 tag 预算。

nl（JSON 的 nl 键）：自然语言——连贯完整的英文句子，与 tag 描述同一画面。本站底层模型（Qwen 编码器）对完整句子的跟随能力强于孤立词组，tag 说不清的结构都该用 nl 讲明：服装构造与穿着方式（衣领、袖口、系带、下摆、材质层次）、肢体与手的几何、姿态先后与接触点、镜头角度与透视、画面内的空间关系、环境与光线氛围的具体状态。
nl 与 tag 是同一画面的两种写法，不是替代：tag 定身份、概念、人数与常见元素（**裸列，不做归属**），nl 补结构与空间；**多人画面里，谁穿哪件、谁在做什么、谁是什么表情，全部由 nl 承担**。单人一到三句；多人按下面结构组织：先一句总起（人数 + as the main focus + 构图，把主体锁在角色上）→ 再每人一句分述，先主动方后被动方 → 最后一句环境氛围，以 blurred in the background 收尾。
每句分述都要带上该角色的**区分性称谓**（the green-haired girl with green eyes ...）——模型不跨句记忆，用 she/they 这类指代会丢失配对；tag 里裸列的特征（本镜头可见服装、体型、个人动作、表情、视线）都在这句里按人归位，一项不落。
区分性称谓 = 足以把此人和同框其他人分开的最短说法（发色 + 瞳色通常就够），不是把他的整串固定外貌重新念一遍：写 the black-haired girl with blue eyes，不要写 1girl, long black hair, blue eyes, petite, white dress 这种把 tag 串塞进句子的写法——那会让模型以为画面里有多个同样的人。
多人画面还要写清位置关系（on the left / on the right / in the center / in the foreground）——位置比名字更能决定谁站在哪里、谁碰谁。
**nl 的最后一句永远是计数锁定句**：No other people or duplicate identities are present.（模型会多画人，这句是实测有效的兜底；位置固定在末尾，不许插在中间或省掉。）
多人 nl 示例（与下面 tag 示例是同一画面）：
Two girls as the main focus, medium shot, in a park at sunset. The black-haired girl with blue eyes on the left wears a white dress and waves at the viewer with a smile. The petite silver-haired girl with red eyes on the right wears a red dress and eats a skewer of dango, blushing and looking away. Warm sunset light across the park, the trees softly blurred in the background. No other people or duplicate identities are present.

多人画面（两人及以上）额外规则：
先把分工记住：**tag 区只放袋装词**（谁有、有什么），**归属与配对全部交给 nl**——不要把服装/体型/动作词用 on 接到别人的外貌短语后面造复合指称（那是给靠位置邻近配对的 CLIP 系模型用的手法，本站的 Qwen 编码器读的是句子），也不要靠反复重念同一个外貌短语来配对。

tag 区：
- 人数 tag 必须明确（1girl、1boy 1girl、2girls、2boys、2boys 1girl、multiple boys 等）；只能用 danbooru 标准词：不要写 2people、3people、multiple people 这类自造总数，danbooru 也没有 1man、2men、1woman——成年男性同样写 boy（大叔与少年同框写 2boys），成年女性同样写 girl；人数 tag 要覆盖画面里所有可见人物（站在画面里、没有被虚化成一片的第三者也算），且每个数量词只写一次——三人同框写 2boys 1girl，不要写 1boy 1girl, 1boy。
- 构图词（medium shot、full body 等，只写一个）紧跟人数 tag 写在前面，把画面主体锁在角色身上。
- 每个角色的硬特征（发色/瞳色）都裸列出来，不要编号（girl1/girl2 模型不认识）——发色瞳色本身就是锚点词，nl 里靠它们指认角色。
- 同类不同款的服装/物件必须都写全，不能靠一个统称糊过去：两人都穿校服但男女版型不同时，写 dark pleated skirt, black opaque pantyhose, white shirt, dark trousers，绝不能只裸写一个 school uniform——那会让模型把裙子套到男生身上，或者干脆给两人各自随机设计一套。
- 多人共有的特征只写一次（如都是长发：一个 long hair 即可，不要每人复制一遍）。
- 锚点只能是正文、设定或角色固定外貌库给出的发色或瞳色：不得从服装、道具的颜色推出发色（写了 yellow jacket 不等于 yellow hair），也不得给没有设定的配角编一个发色来当锚点；配角没有明确发色时用身份词（man、boy、passerby）或直接裸写他独有的可见特征（yellow jacket、helmet）。
- 同一件服装/饰品的措辞整楼逐字复用：同一样东西定下哪种说法，整楼就都用哪种——裤袜不许在 stockings / pantyhose / thigh high stockings 之间来回换（pantyhose 是连裤、thigh high stockings 是过膝袜，正文写的是哪种就写哪种），颈饰不许在 choker / collar / neck ribbon 之间来回换。同义词改写等于换了件衣服，模型每张图都会重画一次；局部件是补充不是替代，整件服装的视觉指纹照旧要写全。
- 各自不同的动作/姿态、表情与视线照常写进 tag（表情视线词表见上），但**不在 tag 里做归属**；两人表情或视线恰好相同时也各写一份。
- 体型词（petite、tall、muscular 等）不是锚点：不要在 tag 区裸写（飘着的体型词会被模型摊到同框每个人身上），只写进 nl 里该角色的那一句。
- 场景词 1~2 个即可，多了会抢角色主体；背景不重要时用 blurred background 类词压住。

nl 区（配对只在这里）：**多人画面 nl 不得为空**——归属没有别处可放，nl 缺了就只剩一串无主词；逐人一句 + 区分性称谓 + 位置词 + 末句计数锁定，写法见上面「nl」段；多人共同参与的互动（holding hands、hug 等）用一句整句写明参与者与接触点。

多人示例（tag 与 nl 是同一画面；注意 tag 里没有任何归属词）：
tag：2girls, medium shot, long hair, black hair, blue eyes, silver hair, red eyes, white dress, red dress, waving, smile, looking at viewer, eating dango, blush, looking away, park, sunset
nl：Two girls as the main focus, medium shot, in a park at sunset. The black-haired girl with blue eyes on the left wears a white dress and waves at the viewer with a smile. The petite silver-haired girl with red eyes on the right wears a red dress and eats a skewer of dango, blushing and looking away. Warm sunset light across the park, the trees softly blurred in the background. No other people or duplicate identities are present.
（tag 只回答「有哪些特征」：构图紧跟人数且只写一个景别词，long hair 是共有特征只写一次，发色瞳色裸列当锚点；谁穿哪件、谁在做什么、谁是什么表情由 nl 的区分性称谓句归位——white dress、waving、smile、looking at viewer 归黑发那位，red dress、eating dango、blush、looking away 归银发那位；petite 是体型词，只写在 nl 里、不在 tag 区裸列；末句是计数锁定句。）

画面补全（重要）：
正文是小说，不是分镜脚本——它永远不会写镜头、光线、时代服饰这些「画出来才存在」的东西。
你的职责不是转录正文，是把文字补全成一幅完整的画。以下四类内容分别对待：

1. 画面语言（镜头、构图、光线、色调、景深、氛围）——**必须主动补全**。
   正文不会写这些，缺了画面就是平庸的大头照。每个画面都要给出：
   镜头距离（close-up / upper body / medium shot / full body / wide shot）、
   光线与时间（soft sunlight、candlelight、moonlight、backlighting、golden hour 等）、
   氛围色调（warm colors、cold colors、muted colors、high contrast 等）。
   这些由你按情绪与场景自行决定，正文没写不是不写的理由。
   ⚠ 景别只能写一个：close-up / upper body / medium shot / full body / wide shot 之间互相冲突，同时写两个（如 medium shot, upper body）会让模型不知道画到哪里，把人截断或拼错。
   ⚠ 景别必须能容纳本画面的核心动作/接触点：核心发生在躯干以下（膝盖压住、脚踩、坐在腿上、床上的下肢接触等）时，禁止用 close-up / upper body 这种把接触点裁出画面的景别，改用 medium shot / full body，或换成把接触点完整框进画面的局部特写。
   ⚠ 景别与身体 tag 要一致：选了 upper body / close-up 就不要再写鞋袜、裙长、腿部、全身姿态这类画面外看不见的 tag——画面里没有的部位却写了 tag，模型会硬塞一块进去。

2. 时代与世界观（服饰体系、建筑、器物、环境风格）——**必须先判断，并主动具体化**。
   依据按优先级取：世界设定（世界书）> 角色设定/主角设定 > 正文与上下文中的称谓、身份、器物和环境。
   有明确设定时严格遵循；没有明确设定时，也要根据现有线索和剧情气质，主动选择一个最合理、具体且自洽的时代、文明或原创视觉体系。证据较少时可以合理补全时代风格、服装版型、材质、配饰、光线与色调，但这种发挥只限于“怎么画”，不得借机编造“画面里有什么”。
   将判断落实到画面实际可见的细节：人物可见时优先完善服装版型、材质和配饰；背景可见时，只补充设定或正文能够支持的建筑、家具、环境和器物。地形、地面或道路材质、天气痕迹及环境状态都属于场景事实，没有依据时保持简洁，不得为了丰富画面自行添加泥地、土路、湿地、积水、积雪、尘土或湿滑地面。
   正文只确定“野外”时写 outdoors 即可，只确定“森林”时写 forest 即可；只有正文、上下文或世界设定明确支持雨后、泥泞、土路等事实时，才写 muddy ground、dirt path、puddles 等对应 tag。
   架空世界可以采用原创或混合风格，但必须内部统一，不得随意堆叠相互冲突的文明元素；连续场景中保持同一套视觉判断。丰富画面优先依靠镜头、构图、光线、色调和有依据的具体细节，而不是把 hanfu、wuxia、ancient chinese architecture 等相关词机械堆进每张图。

3. 角色的固定事实（性别、发色发型、瞳色、体型、标志性特征）——**严格按给定信息，不得发挥**。
   出现在【角色固定外貌库】里的角色，直接照抄库中该角色的字段值写进 tag/nl，用词一字不改（库里写 long black hair 就写 long black hair，不要换成 black long hair 或自行加词）；未建档角色按角色参考/角色设定写，都没有才可少量补基础特征。

4. 剧情事实（在场人物、动作、事件、关键道具）——**严格以正文为准，不得编造**。
   不得加入正文未发生的人物、动作或情节；人数必须与正文一致。

一句话：镜头、构图、光线、色调等**怎么拍**可以主动具体化；人物、动作、地形、地面材质、天气痕迹和环境状态等**画面里有什么**必须以正文与设定为准。具体不等于编造。

画幅方向（size 键）：
先确定最终景别与主体在画面中的空间分布，再决定方向；人数只是参考，不是硬规则。
群像、远景全景、宽阔场景、横向展开的互动写 landscape；单人、纵向站姿、特写以及双人近距离构图可写 portrait。
两人同框不等于必须横屏。方向必须与 tag 里的镜头词一致（wide shot 通常配 landscape，close-up / upper body 通常配 portrait）。

通用要求：
- 不写质量词（masterpiece、best quality、score_7 之类，由系统按 Anima 官方推荐附加）；也不得写 NAI 特训的审美词（very aesthetic、aesthetic、location、no text 等）——Anima 不认识这些词，写了只会挤占 tag 预算。
- **分级词由你写**（safe / sensitive / nsfw / explicit）：按本图实际内容判定——全年龄写 safe，擦边性感写 sensitive，成人内容写 nsfw，明确成人写 explicit。系统不再替你附加 safe，每张图都必须自己写对；同一楼里 SFW 与成人画面混排时各写各的，不许一律套同一个。
- 不写通用负面词。任务规则要求输出 negative 键时，按其规则只写与画面相关的排除项。
- 一律使用英文。`;

/**
 * Latent 思维链内置默认,与 DEFAULT_LATENT_SPEC 一一配对。
 *
 * 回落链的终端:latentThinking(设置页「Latent 思维链」)→ naiThinking(旧 4.5 键,存量
 * 自定义不失效)→ 本常量。协议形态与 ComfyUI 相同(单条 tag 串、归属由 nl 承担),内容按
 * latent 口径分头调:身份 tag 必须转义圆括号(站点按权重语法解析);negative 条件自查为
 * 条件式(画面级负面由 AI 写,通用兜底在渠道级);显式 NSFW 场景有解剖落点。
 */
export const DEFAULT_LATENT_THINKING = `【输出前思考清单】
先在 <thinking> 与 </thinking> 之间按下面顺序过一遍，思考结束后再输出最终 JSON。除这一个 <thinking> 块与最终 JSON 外，不得输出任何内容，也不得开启第二个 <thinking> 块。
第一层 A～E 是整楼只做一次的判断；第二层是逐张图的槽位块，每张入选图都要各写一块。分条写关键结论，不复述正文、不写寒暄、不重复抄写后端规范。
全程只写结论，不写推演过程：思考是给你自己理清事实用的草稿，不是答题过程。每个判断一次定死——同一个字段在整个 <thinking> 里只准出现一次取值，不写「A？还是 B？」式的自问，不提出候选再逐个否决，不把已定好的字段推翻重选，也不预写最终的 tag/nl 串。证据不足时按本清单和后端规范的兜底口径直接决定（size 拿不准写 portrait，服装细节不明就选一套常见且自洽的），定了就往下走。

第一层｜全局判断（整楼各做一次）

A. 事实与状态账本
   - 只给目标正文选图；此前上下文只用于理解人物、场景和连续性。目标正文的明确事实优先，其次是紧邻上下文；历史 <bbi_image> 只作连续性线索，不能覆盖正文。
   - 区分三类状态：角色库中的永久事实；连续场景中应继承的临时状态（衣物穿脱程度、湿身/污渍、伤势、饰品、手持物等）；只属于单帧的表情、视线和具体姿势。
   - 没有明确穿回、整理、换装、解除状态、时间跳跃或场景切换时，不得把临时状态恢复成角色默认值。

B. 角色清点与建档（具体建档字段与写法见任务协议，这里只做清点判断）
   - 通读目标正文，逐个列出实际在场且有名有姓的角色。不能只看最终入选图片里的人，也不能漏掉世界书、角色卡或柏宝书为其给出了设定的角色。
   - 每人写一行结论：命中的同名库条目，或本次 field:"new"。只有名字实际列在【角色固定外貌库】区块中的才算已建档——世界书、角色卡、柏宝书或正文里的详细设定只是建档来源，不代表已经在库，不得凭印象宣称已在库。库里没有、但属于正式角色（有设定或持续参与剧情）的，首次出场就建档，不论他是否入选本次图片；一次性无名路人不建。
   - 同一行里顺带判定原创还是同人：只有角色卡、世界书、正文或通行角色名能可靠指向某个已有作品时才判为同人，证据不足按原创处理，不猜作品。判定为同人时同一行定出最终身份 tag 词：模型可识别的英文 Danbooru 角色名与作品名，落 tag 的实际形态为 character name \\(copyright name\\)——括号必须转义（站点按权重语法解析圆括号），最终 JSON 里要写成 "character name \\\\(copyright name\\\\)"，双反斜杠经 JSON 解析才保留单个反斜杠；**但写进档案的 fields.fandom 存未转义原文 character name (copyright name)**——档案是存储形态、落 tag 才转成提示词形态，两处别混（存了转义形态会在照抄时二次转义）；位置在人数/构图之后、普通外貌之前。
   - 缺发色、发型或瞳色时一次性补全：hair 必须同时带发色和长度/发型（long black hair 行，只写 black hair 这种裸颜色不行），eyes 必须带瞳色；建档在本楼全程有效，不要对同一角色给出两套外貌。
   - 对照角色库检查永久变化：染发、剪发、永久变身等写入 changes 并标出生效 P编号；假发、美瞳、湿发、光照变色等临时状态不写。即使 images 为空也不能跳过这一步。

C. 服装时间线（每个在场角色一行：从 P 几起穿的是什么）
   - 按正文 P 位置维护每个角色的临时服装：正文未明确初始穿着时合理决定一次；没有穿脱、换装、衣物损坏或场景/时间跳跃就沿用上一状态，明确变化后从对应 P 位置起更新。
   - 每套服装冻结一份「视觉指纹」（版型/剪裁 + 主色 + 关键部件，裤袜含颜色与透明度，具体要求见任务协议），相同状态全楼复用同一份，不要写成 school uniform、dress、pantyhose 这类模型会自行重新设计的孤立词。

D. 时代与世界观（一次判断，全楼通用）
   - 定一套具体、自洽的时代/文明/视觉体系并全楼沿用：有明确设定就严格遵循，证据少也要主动选一个，不得退回中性服装或默认现代都市。落实到服装版型、材质、配饰和有依据的建筑器物上。
   - 这套判断只决定「怎么画」，不得借它把未知的场景事实具体化。

E. 选段
   - 候选必须是一个可见瞬间，有明确主体、动作或视觉状态和场景。纯对话只有在伴随值得画的表情、肢体动作、人物关系或环境变化时才保留；只跳过没有视觉变化的对话、纯心理和过渡。
   - **画面里出现人物时，必须至少有一位女性角色**：纯男性画面（1boy、2boys、1boy 1other 这类一个女性都没有的）一律不作候选——哪怕它视觉明确度最高、哪怕数量下限还没凑够。无人物画面（风景、空镜）不受此限。整楼确实找不到任何含女性的可见瞬间时，images 返回空数组（建档与 changes 照常完成），不要用纯男性画面凑数。
   - 按视觉明确度、剧情重要度、动作完整度、与其他候选的差异度排序，并遵守任务协议给出的最少～最多数量：下限大于 0 时从较次但仍可见的候选中补足；达到下限后只继续选择足够强且彼此明显不同的画面，不要用同一事件的相邻动作或不同镜头凑近上限。
   - 给每张入选图选定 P编号：让画面所需事实刚刚完整成立、且尚未切换到下一场景的位置。最后写出选定的 P 列表。
   - 数量在这里就要卡死：写出 P 列表之前先数一遍，多于上限就当场砍到上限再往下走。第二层只为最终入选的 P 写块，绝不允许先超额写完几块、再到第三层发现超限回头删——那几块是白写的，而且第三层只核对、不改决定。

第二层｜逐张图槽位块（E 选定的每个 P 各写一块，不得合并、不得跨图共用一份）

每张图各写一块，把下面每个槽位都写出取值。行文形态随你，但七个槽位一个都不能少——漏掉任何一个都会让最终 tag 缺一块。

■ P<编号>
  人物：<人数 tag + 在场角色名；无人物画面写 no humans>
  核心动作：<谁的哪个身体部位接触了什么，先用中文点明接触点，再给英文 tag>
  景别：<close-up / upper body / medium shot / full body / wide shot 中只选一个，且必须完整容纳上面的接触点>
  角色行（每个在场角色各一行）：<角色名>｜表情｜视线｜本镜头可见服装｜临时状态｜个人动作
  场景：<地点 + 画面里实际可见的关键道具>
  环境光：<光源 + 时间 + 色调>
  size：<portrait / landscape>

槽位填写要求（槽位值直接写你最终要放进 tag 的英文词；确实不适用的槽位写 "-"，但核心动作、景别、表情、视线、场景、环境光、size 七项永远不得为 "-"）：
   - 每个槽位只写最终决定，一次定死。判断标准很简单：一个槽位在你的思考里只准出现一次取值。写下 size：portrait 之后就不许再提这个字段，写下表情：smile 之后也不许再讨论要不要改成别的。
   - 具体禁止这三种写法：带问号的自问（「landscape？」「用 blush？」）、并列候选（「expressionless 或 slight smile」）、写完再推翻（「用 A……不过 B 更好，改 A 为 B」）。心里比较完直接写结论，把比较过程留在心里。证据不足时按兜底口径直接定（size 拿不准写 portrait，服装细节不明就选一套常见且自洽的），定了就往下走。
   - 也不要在槽位里附上选择理由或对 danbooru 词表的检索过程（「looking ahead 不在标准列表」这类）——规范给了什么词，直接从里面挑一个填上。
   - 单一瞬间：一块只能是一次快门完整拍下的画面，不要把先后发生的多个动作、多个时间点或因果过程塞进同一块；剧情事实严格按正文，不编造人物、动作或人数。
   - 表情与视线填后端规范给出的标准 danbooru 词，不写中文感受也不自创词组（想写「温柔地笑」就填 smile）；只能从规范列出的词里挑，规范没列的词一律不许用，拿不准就填 expressionless / looking at another。两项都不得留空，面无表情也要主动填 expressionless。多人画面每人各填一份，**落 tag 时照常裸写这些词、不做归属**：归属写进 nl 里该角色的那一句（区分性称谓 + 表情 + 视线），漏写那一句等于这个角色没有表情，会被模型画成木脸（例外：画面里根本不出现脸的局部特写——只拍手、腿、脚、道具——两项都允许留 "-"，硬写只会让模型给没脸的地方塞一张脸）。
   - 若正文明确为显式 NSFW 场景：核心动作与角色行逐人点明镜头中实际可见的性器官、身体部位和接触关系（谁的什么部位接触或进入哪里），落 tag 时用准确 danbooru 词写出；不得只用 nsfw、nude、sex 或含蓄措辞代替关键解剖信息，被衣物、身体或镜头完全遮住的部位不得写成可见。
   - 角色行是每个在场角色各一行，配角也要写全，不许只给主角写完整一行、配角用一句中文动作带过。每一行的表情与视线都必须各是一个独立的英文 danbooru 词：写成「看向另一侧、弯腰换鞋」这种中文短语等于这一行没有表情词，落 tag 时这个角色就会没有表情，被模型画成木脸。
   - 可见服装照 C 中该角色当前状态的视觉指纹逐件写全，只写本景别看得见的部件；镜头外不可见的部件可以省略，但省略不等于脱掉，后续重新可见且中间没有变化时必须恢复。槽位里不许退回 school uniform、dress、pantyhose 这种笼统孤立词——C 段定的是 navy school blazer 就写 navy school blazer，写笼统词等于让模型自己重新设计这套衣服，同一角色每张图都会换个款式。多人画面每人的服装都裸写进 tag，归属由 nl 里各自那一句承担：两人都穿校服但男女版型不同，tag 里只裸写一个 school uniform 会让模型把裙子套到男生身上。
   - 场景和环境光：场景只写正文、上下文或世界设定能支持的事实，地形、地面材质、天气痕迹和环境状态都算事实，没依据就别写；环境光则相反，光源、时间和色调正文不会写，必须由你主动定，缺了画面就是平庸的大头照。

第三层｜落笔前自查（只核对，不预写答案）

这一层只逐张核对下面几条，每点写一句结论即可。<thinking> 里禁止出现任何最终答案的草稿——不写完整 tag 串、不写完整 nl 句、更不要写出 JSON 对象或 "JSON:" 之类的标题。答案只在 </thinking> 之后出现一次，在思考里先写一遍等于把整份输出付两遍钱。核对完直接闭合 </thinking> 并输出 JSON：
   - 每张图的 tag 覆盖了它自己那一块的全部非 "-" 槽位，没有漏掉表情、视线或环境光；nl 与 tag 描述同一画面，并补上 tag 说不清的服装构造、肢体几何与空间关系。
   - 每个剧情 tag 都能追溯到正文/设定；地形、地面、道路、天气和环境状态 tag 没依据就删除。
   - 每张图都写了与画面内容相符的分级词（safe / sensitive / nsfw / explicit）：全年龄 safe、擦边 sensitive、成人 nsfw、明确成人 explicit；同楼混排时各写各的，没有漏写、也没有一律套同一个。
   - 多人画面：tag 区没有复合指称（没有 "X on Y girl"、没有重复的 "X hair girl"），tag 里实际写出的角色与人数 tag 对得上；服装、体型、个人动作、表情、视线都在 nl 里按人归位到各自的区分性称谓句，每个在场角色都有一句、句里不缺项；nl 的末句是计数锁定句 No other people or duplicate identities are present.；每个在场角色的服装都在 tag 里实际出现了，没有 school uniform、pantyhose 这类没主人的笼统孤立词。
   - 人数：每个数量词只出现一次（三人同框写 2boys 1girl，不写 1boy 1girl, 1boy），没有 1man、2men、1woman、2people、multiple people 这类 danbooru 不存在的自造词；画面里所有可见人物（没被虚化成一片的第三者也算）都进了人数 tag。
   - 画面里的发色与单品没有一条来自规范示例（规范里出现的发色、服装、配饰全是占位例子，照抄等于编造）。
   - 这一层只核对、不改决定：发现问题就在落 tag 时直接改对，不要在思考里写出「超限，需精简」「让位」「改为」这类修订过程。张数在 E 段就已经定死，这里不该再变。
   - 每个同人角色的 tag 串里都有 B 段定下的 character name \\(copyright name\\) 身份 tag（人数/构图之后、普通外貌之前，括号已转义），原创角色没有被误加作品名。
   - tag 串里没有混入画师/画风 tag（artist: 或 @ 开头的画风词都不该出现），画风由系统按用户画师串附加。
   - 若本图协议含 negative 键：negative 已逐词对照本图的 tag 与 nl，凡是能在其中找到对应内容的词都已删掉，没有抵消正文已成立的事实；拿不准的已留空。协议不含 negative 键时本项直接跳过。
   - 若本图是显式 NSFW 场景：实际可见的性器官、身体部位和接触关系都已用准确 tag 写明，没有只用 nsfw、nude、sex 这类泛化词一笔带过；非显式场景本项直接跳过。
   - 每个在场正式角色都能二选一：指出【角色固定外貌库】中的同名条目，或在 changes 中有 field:"new"；世界书里有详细设定不能代替建档。每条 field:"new" 建档的 hair 都同时带发色和长度/发型、eyes 都带瞳色。永久变化的 P编号合法，临时状态没被误写进 changes。
   - 张数在设定范围内；仅当下限为 0 且确实无可画时 images 才为空，且无论如何都保留应有的建档与 changes。`;
