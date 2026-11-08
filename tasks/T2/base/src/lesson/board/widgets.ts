/**
 * 显示板图示（PRD §7.6 / ADR #34）：知识点内容里的讲解演示、教课例题与每道题，都用这套图示描述「显示板上摆什么」。
 * 一块板摆 1–3 个图示，自上而下排列。纯数据与校验，不依赖界面（校验脚本与课堂共用）。
 *
 * 数值字段可以是数字，也可以是参数化题的模板字符串（如 "{a}"、"{a+b}"），由程序出数后换成数字再上板；
 * 题目里要让孩子求的数，用 "?" 表示（数的分合、条形模型、竖式、数轴等支持）。
 * 二至六年级补充（2026-09-28）：位值表、分数图、扇形图、条形与折线统计图、表格、角、平面作图、立体、小正方体堆、
 * 直尺、量具、长除法、日历、时间线、集合圈；数轴支持小数与分数刻度，竖式支持乘法与小数，钟面支持秒针与电子钟。
 * 五国并集补充（2026-10-06）：中国算盘、计数符号统计表、流程图；英寸／英尺直尺、罗马数字钟面、数轴上叠点（点图／线图）、
 * 象形统计图的半个图标、三棱柱与标出面／棱／顶点。
 * 第三批（四、五年级，2026-10-06）：角的射线分出几个小角（平角上、一点处）、等距点阵（画立体图）、直方图、流程图步骤跳转；硬币正反面（掷硬币）。
 * 第四批（2026-10-07）：容量与生活用品图标（勺、碗、浴缸、罐头、玻璃罐、水瓶、一升大纸盒）、正 n 棱柱（sides 4–8，如铅笔的六棱柱）、
 * 优角（大于 180°，弧走大的那一边、标注在弧外；有射线时整个角另画外圈弧）、平面图与直尺同板时直尺只占自己的高度。
 */

/**
 * 物件图标：显示板上摆的小东西；第二、三行是生活场景（时间、方位、分类题用，学前孩子不识字也看得懂），其后是二至六年级补充。
 * 最后一行是容量题用的生活用品：spoon 茶匙、bowl 碗、bathtub 浴缸、can 罐头、jar 玻璃罐、waterbottle 水瓶、carton 一升装的大纸盒（牛奶、果汁）
 */
export const ICONS = [
  "star", "apple", "ball", "block", "car", "fish", "flower", "bird", "bear", "cookie", "pencil", "balloon",
  "banana", "ladybug", "rocket", "cup", "egg", "leaf", "shell", "sweet", "duck", "orange", "book", "sock",
  "sun", "moon", "cloud", "tree", "house", "bed", "bus", "cat", "dog", "cake", "shoe", "umbrella", "toothbrush", "schoolbag",
  "child", "chair", "hat", "bicycle", "wheel", "watermelon", "feather", "gift", "grapes", "carrot", "rabbit", "frog", "butterfly", "icecream", "bread",
  "pizza", "chocolate", "sandwich", "cherry", "strawberry", "lemon", "pear", "peach", "pineapple", "tomato", "corn", "pumpkin",
  "donut", "cupcake", "lollipop", "pancake", "juice", "milk", "teapot", "box", "bottle", "basket", "bucket", "coin", "gem", "key",
  "bell", "bulb", "dice", "card", "envelope", "paper", "pen", "crayon", "scissors", "flag", "ticket", "trophy", "medal", "ribbon",
  "boat", "train", "plane", "tent", "kite", "drum", "shirt", "jeans", "dress", "cap", "plant", "bee", "ant", "chick", "chicken",
  "pig", "cow", "sheep", "horse", "monkey", "penguin", "tap", "water",
  "paperclip", "lorry", "elephant", "stopwatch", "spider", "goat", "robot", "door", "ladder", "hand", "octopus",
  "spoon", "bowl", "bathtub", "can", "jar", "waterbottle", "carton",
] as const;
export type Icon = (typeof ICONS)[number];

export const SHAPES = [
  "circle", "square", "triangle", "rectangle", "parallelogram", "trapezium", "semicircle", "oval",
  "pentagon", "hexagon", "octagon", "rhombus",
  "cube", "cuboid", "cylinder", "sphere", "cone", "pyramid", "prism",
] as const;
export type Shape = (typeof SHAPES)[number];

export const COLORS = ["red", "blue", "yellow", "green", "orange", "purple", "pink", "white", "black", "grey"] as const;
export type Color = (typeof COLORS)[number];
/** 统计图没写颜色时按顺序配色（几组数据、扇形的各块）：画板（web/src/lesson/board/draw.tsx）与板面说明共用这一份 */
export const SERIES_COLORS: Color[] = ["blue", "orange", "green", "pink", "purple", "yellow", "red", "white"];

/** 新加坡硬币与纸币，单位：分（cent） */
export const MONEY_VALUES = [5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000] as const;
/**
 * 钱币图示的币种（ADR #43：认钱币各国各一颗）：缺省新加坡元；其余只给该国特有的认钱币星用。
 * 面值单位都是该币的最小单位（分／便士／分），coins 画成硬币、notes 画成纸币；
 * paper 为硬币、纸币都有（或只有纸币）的小面值，写 note: true 才画成纸币（人民币 1 角、2 角、5 角与 1 元纸币）
 */
export const CURRENCIES = ["sgd", "aud", "cny", "gbp", "usd"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const MONEY: Record<Currency, { coins: readonly number[]; notes: readonly number[]; paper?: readonly number[] }> = {
  sgd: { coins: [5, 10, 20, 50, 100], notes: [200, 500, 1000, 5000, 10000] },
  aud: { coins: [5, 10, 20, 50, 100, 200], notes: [500, 1000, 2000, 5000, 10000] },
  cny: { coins: [1, 2, 5, 10, 50, 100], notes: [500, 1000, 2000, 5000, 10000], paper: [10, 20, 50, 100] },
  gbp: { coins: [1, 2, 5, 10, 20, 50, 100, 200], notes: [500, 1000, 2000, 5000] },
  usd: { coins: [1, 5, 10, 25], notes: [100, 500, 1000, 2000, 5000, 10000] },
};

/** 位值表的数位，从高到低（亿以内的整数与三位小数） */
export const PLACES = [
  "hundred millions", "ten millions", "millions", "hundred thousands", "ten thousands", "thousands",
  "hundreds", "tens", "ones", "tenths", "hundredths", "thousandths",
] as const;
export type Place = (typeof PLACES)[number];
/** 数位对应 10 的几次方：ones = 0，tenths = -1 */
export const placePower = (p: Place) => 8 - PLACES.indexOf(p);

/** 数值：数字、模板字符串（"{a+b}"）或待求的 "?" */
export type Num = number | string;
/** 平面图上的一个点 [x, y]：单位是格，原点在左下角，y 向上 */
export type Pt = [Num, Num];
/** 平面图形与圆的填色：shade 浅色填充（缺省）、none 只画边、hole 挖空（用板面底色盖住，画阴影部分用） */
export type Fill = "shade" | "none" | "hole";
/** 正多边形：边数、中心、中心到顶点的距离（格）、再逆时针转几度、画不画辐条 */
export type Regular = { sides: Num; center: Pt; r: Num; rotate?: Num; spokes?: boolean };
/** 平面图上的一个形状：points 依次为各顶点，或用 regular 按参数画正多边形（两者只写一个） */
export type PlaneShape = {
  points?: Pt[]; regular?: Regular; open?: boolean; color?: Color; fill?: Fill; dashed?: boolean; label?: string; labelAt?: Pt;
  sides?: (Num | null)[]; angles?: (Num | null)[]; right?: number[]; names?: string[]; parallel?: number[][];
};
/** 箱线图的五个数 */
export const BOX_KEYS = ["min", "q1", "median", "q3", "max"] as const;
export type BoxKey = (typeof BOX_KEYS)[number];

export type Widget =
  /**
   * 物件：一组或几组（点数、比多少、分类、排队）。layout 缺省为 groups（几堆并排、各带标签）；
   * row 把各组连成一整排（排队）；rows 每组单独一行、左对齐、标签在左（比多少、一一对应）；scatter 散放。
   * highlight 为从 1 数起第几个（可写几个）；front 标出队头在哪一端（row／rows 用）。
   * numbered 在前几个头上依次标 1、2、3…（数数，从队头数）；ring 用一道光圈把全部圈在一起，圈上写这几个字（如总数 "5"）。
   * pairs 只用于 rows：前两行从左起前几对上下连线（一一对应配对，配不上的剩在外面）。
   * numberedFrom 让标数从第几个起（缺省 1）：如队头是参照物时，从第 2 个起给后面几只标 1、2、3。
   */
  | { type: "objects"; groups: { icon: Icon; count: Num; label?: string }[]; layout?: "scatter" | "row" | "rows" | "groups"; highlight?: Num | Num[]; front?: "left" | "right"; numbered?: Num; numberedFrom?: Num; ring?: string; pairs?: Num }
  /** 相同的几组（几个几），容器缺省为盘子；extra 为容器外剩下的几个（有余数的分装） */
  | { type: "equalGroups"; groups: Num; perGroup: Num; icon: Icon; container?: "plate" | "box" | "bag"; extra?: Num }
  /** 行列排布（乘法的点阵）：split 在第几列／第几行后画虚线分开（拆分 4 × 7 = 4 × 5 + 4 × 2）；hollow 只画最外一圈（空心方阵） */
  | { type: "array"; rows: Num; cols: Num; icon: Icon; split?: { cols?: Num; rows?: Num }; hollow?: boolean }
  /**
   * 十格阵：一个或两个，填了几格（从上排左起）。glow 高亮：row 满了的整排、frame 满了的整框（框上写 10）、empty 空格；
   * numbered 给第 a 到第 b 个标上序数（接着数 11、12）
   */
  | { type: "tenFrame"; filled: Num; frames?: 1 | 2; icon?: Icon; glow?: "row" | "frame" | "empty"; numbered?: [Num, Num] }
  /** 数的分合：整体与两个部分，未知的用 "?"；部分写 "" 时还没分（只画整体，动效里分出两个部分） */
  | { type: "numberBond"; whole: Num; parts: [Num, Num] }
  /**
   * 数轴：from–to，可标记点、画跳跃弧线、藏起某些刻度数（显示为 ?）。step 可为小数（0.1、0.25）；
   * denominator 按分数刻度（每格 1/denominator，标成 1/4、2/4、1、1 1/4……，不再写 step；simplify 时刻度写成最简分数：2/4 写 1/2、1 6/8 写 1 3/4）；labelEvery 每几格标一个数；
   * labels 在某点上方写字（如 A、?）。marks／hidden／jumps／labels 的位置可写数，也可写分数 "3/4"、"1 1/2"。
   * 刻度数四位起加千分位（1,000）；years 为 true 时刻度是年份，照写 2024。
   * dots 在某处上方摞几个点（点图、美国的线图 line plot），at 的写法同 marks，count 0–12；dotStyle 为 dot（圆点，缺省）或 x（叉）。
   * 不等式的解集（六年级）：ray 在 at 处画一个圈、从圈起沿数轴向 dir（left／right）画一条粗线到端点并带箭头，open 必写：
   * true 为空心圈（不含这个数：> 或 <），false 为实心圈（含这个数：≥ 或 ≤）；如 x > 120 写 { at: 120, dir: "right", open: true }。
   * segment 画两端各一个圈的粗线段（3 < x ≤ 7 写 { from: 3, to: 7, openFrom: true, openTo: false }）；ray 与 segment 只写一个
   */
  | { type: "numberLine"; from: Num; to: Num; step?: Num; denominator?: Num; labelEvery?: Num; marks?: Num[]; jumps?: { from: Num; to: Num; label?: string }[]; hidden?: Num[]; labels?: { at: Num; text: string }[]; years?: boolean; dots?: { at: Num; count: Num }[]; dotStyle?: "dot" | "x"; simplify?: boolean; ray?: { at: Num; dir: "left" | "right"; open: boolean }; segment?: { from: Num; to: Num; openFrom: boolean; openTo: boolean } }
  /** 位值：百、十、一（小方块、计数器或数位表）；待求的数位写 "?"；小方块的十和一都可到 19（退位后 4 个十 16 个一、凑成一条或一块百板之前） */
  | { type: "placeValue"; hundreds?: Num; tens: Num; ones: Num; style?: "blocks" | "abacus" | "chart" }
  /**
   * 位值表（大数与小数）：给出整个数，程序拆成各数位；places 指定显示哪些数位（缺省从最高非零位到最低非零小数位，至少到个位），
   * hide 里的数位显示为 ?；style 为 chart（数位表，缺省）或 discs（数位圆片，每位画几个写着 1000、100、10、1、0.1 的圆片，最多 5 位）
   */
  | { type: "placeChart"; number: Num; places?: Place[]; hide?: Place[]; style?: "chart" | "discs" }
  /**
   * 条形模型：一条或几条（比较），每条 1–10 段；段的 value 写数、"?"（待求）、""（空白等份，单位模型）或短文字（如 "2/5"、"$36"、"3 units"，分数上下排）；
   * size 只定这段画多长（按比例，不显示），未知段或文字段想画准比例时写；total 为总数，totalSide 为 top（缺省，括在第一条上方）或 right（竖括号括住所有条，和差、按比分配用）
   */
  | { type: "barModel"; bars: { label?: string; parts: { value: Num; label?: string; size?: Num }[] }[]; total?: Num; totalSide?: "top" | "right" }
  /** 图形：平面与立体（小图标，不标尺寸；要标边长、角度用 plane／solid）；highlight 为从 1 数起第几个（按各项依次数）画圈 */
  | { type: "shapes"; items: { shape: Shape; color?: Color; count?: Num; size?: "small" | "big" }[]; highlight?: number[] }
  /** 钟面：时与分，可加秒针（second）；digital 画成电子钟（12h 时 1–12，24h 时 0–23）；period 写 a.m.／p.m.；roman 让钟面写罗马数字 I–XII（只用于指针钟） */
  | { type: "clock"; hour: Num; minute: Num; second?: Num; digital?: "12h" | "24h"; period?: "a.m." | "p.m."; roman?: boolean }
  /** 钱币：面值（该币最小单位）与张数；currency 缺省为新加坡元（各国币值见 MONEY）；note 把硬币、纸币都有的小面值画成纸币（见 MONEY 的 paper） */
  | { type: "money"; items: { value: Num; count: Num; note?: boolean }[]; currency?: Currency }
  /** 规律：每一项是图标名、「颜色 图形」或数字文字；missing 为从 0 数起要孩子补的位置（显示为 ?）；highlight 为从 0 数起画圈的几项；box 为 [从第几项起, 几项]，框出一组（重复的那一段） */
  | { type: "pattern"; sequence: string[]; missing?: number[]; highlight?: number[]; box?: [number, number] }
  /**
   * 比长短、高矮：几样东西的长度（同一单位）。color 缺省时按标签里的颜色词上色（如 red ribbon 画红色），都没有就按顺序配色；
   * vertical 竖着立（比高矮）；start 让这一样的起点错开（画「两端没对齐就比」的错法）。
   */
  | { type: "lengths"; items: { label: string; length: Num; icon?: Icon; color?: Color; start?: Num }[]; unit?: string; vertical?: boolean }
  /** 比轻重：天平两边放的东西（开头可带一个 emoji，如 "🍉 watermelon"，盘上画大图）与哪边重；也可写算式（"x + 3"、"10"）表示等式；写 "" 是空盘（动效里先空着、再放上去） */
  | { type: "balance"; left: string; right: string; heavier: "left" | "right" | "same" }
  /** 方位：几行几列的格子里放物件（上下、左右、前后、第几行第几个）；compass 在角上画指北箭头 */
  | { type: "grid"; rows: Num; cols: Num; items: { icon: Icon; row: Num; col: Num; label?: string }[]; compass?: boolean }
  /**
   * 象形统计图：待求的数量写 "?"；scale 为一个图标代表几个（写了就在图下注明 "Each ⭐ stands for 2"，count 仍是画几个图标）。
   * count 可以 .5 结尾（3.5）：最后半个图标只画左半，须配偶数的 scale（半个图标代表整数个）
   */
  | { type: "pictureGraph"; categories: { label: string; icon: Icon; count: Num }[]; scale?: Num }
  /** 百数表：from–to，高亮或藏起某些数；crossed 划掉、circled 圈出（筛质数：划掉倍数、圈出质数） */
  | { type: "hundredChart"; from?: Num; to?: Num; highlight?: Num[]; missing?: Num[]; crossed?: Num[]; circled?: Num[] }
  /**
   * 竖式：上下两数与运算（+、-、×），小数按小数点对齐；结果可以是 "?"；某几位数字待求时写成字符串如 "4?7"。
   * partials（只用于 ×、两个整数、下面的数 10–999）列出分步乘积再相加；写成数组时按个位、十位……依次给出每行分步积（可写 "?"、"4?0"，用来问某一行或画错例）。
   * carries 为进位、退位的小数字，从个位列起依次写（不写的列写 null），画在上面的数上方（退位后的个位可写 16 这样的两位数）；
   * crossed 为上面的数里划掉的几位（从个位列起数，个位为 0），退位时划掉原来的数字。
   */
  | { type: "column"; top: Num; bottom: Num; op: "+" | "-" | "×"; result?: Num; partials?: boolean | Num[]; carries?: (Num | null)[]; crossed?: number[] }
  /**
   * 长除法（除号为「厂」形的竖式）：divisor 为 1–99 的整数（除以小数先化成整数再上板）；dividend 可有至多三位小数。
   * show：question 商处写 ?（缺省）、answer 写出商（有余数写 R）、working 写出完整的除的过程；places 算到商的第几位小数（除不尽时补 0 继续除）；
   * steps 只用于 working，只画前几步（问「接下来除哪个数」「这一步商几」）；
   * last 配合 steps，最后一步只写到哪儿（讲解时一拍一个动作）：digit 只写商的这一位，product 再写乘积与横线，left 再写差（还没落下下一位）；不写就是整步（连同落下的下一位）。
   */
  | { type: "division"; dividend: Num; divisor: Num; show?: "question" | "answer" | "working"; places?: Num; steps?: Num; last?: "digit" | "product" | "left" }
  /**
   * 分数图：一个整体平均分成 parts 份，涂色 shaded 份；shaded 超过 parts 时画几个整体（假分数、带分数，最多 5 个整体）。
   * shape：circle（最多 12 份）、rectangle（最多 100 份，rows 指定分几行，如 100 份画成 10×10 的百格图）、bar（分数条，最多 24 份，独占一行）；
   * unequal 画成不相等的几份（2–4 份的反例：不是平均分就不是几分之一）；label 写在图下（如 "1/4"、"A"、"?"）。
   * shaded2／color2 在第一种颜色之后再涂几份第二种颜色（同分母加法 2/7 + 3/7；只用于一个整体，缺省黄色）。
   * split 把每份再细分成几小份（虚细线，讲等值分数 1/3 = 2/6）；square 让长方形画成正方形外框（十条与百格图同样大，比较 0.3 与 0.30）。
   */
  | { type: "fraction"; shape: "circle" | "rectangle" | "bar"; parts: Num; shaded: Num; rows?: Num; unequal?: boolean; label?: string; color?: Color; shaded2?: Num; color2?: Color; split?: Num; square?: boolean }
  /** 扇形统计图或转盘：各块的值按比例画；show 标百分数、分数、圆心角（angle，如 90°）、原值或不标；hide 里的块（从 0 数起）标成 ?；spinner 画成带指针的转盘 */
  | { type: "pie"; slices: { label: string; value: Num; color?: Color }[]; show?: "percent" | "fraction" | "angle" | "value" | "none"; hide?: number[]; spinner?: boolean; title?: string }
  /**
   * 条形统计图：categories 为横轴各类，series 为一组或几组（复式，要写 label 作图例）数据，值可写 "?"（画虚线空条）；
   * max／step 定纵轴刻度（缺省自动取整），labelEvery 每几条格线标一个数（读「没标数的格线」），horizontal 横着画，showValues 在条上标数，unit 为数量单位；
   * refLine 画一条水平参考线（如平均数，label 写在线端）；histogram 画成直方图：条与条紧挨着、不留空（分组区间 0–9、10–19……，
   * 横轴照 categories 写在各条下面），只用于一组数据、竖着画。
   * min 让数轴不从 0 开始（讲「误导性的统计图」）：轴底仍标 0，紧挨着画一个折断记号（之字），刻度从 min 起；各值都不能小于 min，
   * 写了 max／step 时 min 也要落在刻度上。不写 min 时从 0 开始、不画折断记号
   */
  | { type: "barChart"; categories: string[]; series: { label?: string; values: Num[]; color?: Color }[]; min?: Num; max?: Num; step?: Num; labelEvery?: Num; horizontal?: boolean; unit?: string; title?: string; showValues?: boolean; refLine?: { value: Num; label?: string }; histogram?: boolean }
  /**
   * 箱线图（六年级）：下面一条数轴 from–to（step 每格多少，缺省自动取 1、2、5、10……；labelEvery 每几格标一个数；unit 写在轴右端下面），
   * 上面画一组或上下两组（plots 1–2 项，第一项在上）：须从 min 画到 q1、q3 画到 max，箱从 q1 到 q3，中间一道线是 median；五个数都要写数，
   * 按 min ≤ q1 ≤ median ≤ q3 ≤ max，且都在数轴上。label 写在这一组左边（如 "Class A"）；
   * hide 里的几个（"min"、"q1"、"median"、"q3"、"max"）在对应位置写 ?（箱照样按真数画，请孩子从数轴读）；showValues 把其余的数也写上。
   */
  | { type: "boxPlot"; from: Num; to: Num; step?: Num; labelEvery?: Num; unit?: string; title?: string; showValues?: boolean; plots: { label?: string; min: Num; q1: Num; median: Num; q3: Num; max: Num; color?: Color; hide?: BoxKey[] }[] }
  /**
   * 折线统计图：labels 为横轴各点（如月份、时刻），series 为一条或两条折线（复式要写 label；某点写 "?" 就不画这个点、在那里标 ?）；min／max／step 定纵轴，labelEvery、refLine 同条形图；
   * numericX 时 labels 须是数，各点按数值排在横轴上（第一个数在纵轴上，画正比例「过原点」用）
   */
  | { type: "lineGraph"; labels: string[]; series: { label?: string; values: Num[]; color?: Color }[]; min?: Num; max?: Num; step?: Num; labelEvery?: Num; unit?: string; title?: string; showValues?: boolean; refLine?: { value: Num; label?: string }; numericX?: boolean; xTitle?: string }
  /** 表格：header 为表头一行（可省），rows 为各行（最多 11 行 11 列，放得下 1–10 的乘法表）；单元格写数或短文字，"?" 为待求；rowHeaders 把第一列当表头；highlight 为 [行, 列]（从 0 数起，不含表头行，含表头列；行写 -1 是表头那一格） */
  | { type: "table"; header?: Num[]; rows: Num[][]; title?: string; rowHeaders?: boolean; highlight?: [number, number][] }
  /**
   * 角：degrees 度（1–360，90 画直角记号；标 "?" 时画弧不画直角记号，免得泄露答案，各小角同理），turn 为第一条边从水平向右逆时针转过的度数；label 写在角里（如 "?"、"x"、"35°"）；
   * protractor 叠一把量角器（degrees ≤ 180）；names 为三个点的名字 [边上一点, 顶点, 另一边上一点]（∠ABC）；
   * rays 在两边之间再画几条射线（从第一条边起逆时针的度数，依次增大），把角分成 rays+1 个小角（每个至少 10°），parts 为各小角的标签（不标的写 null，这个小角不画弧；不写 parts 时各小角只画弧）：
   * 平角上的几个角写 degrees 180、rays 1–2 条，一点处的几个角写 degrees 360、rays 2–3 条。有 rays 时不画整个角的弧，各小角各画一道弧，
   * label 写在角外、顶点的另一侧（如平角写 "180°"；360 没有角外，不能写 label）。
   * 优角（degrees 大于 180、小于 360）：弧走大的那一边，label 写在弧外；有 rays 时整个角在各小角外面另画一道大弧，label 写在这道弧外（不压顶点）。
   * 直角记号只画在正好 90° 的角或小角上
   */
  | { type: "angle"; degrees: Num; turn?: Num; label?: string; protractor?: boolean; names?: [string, string, string]; rays?: Num[]; parts?: (Num | null)[] }
  /**
   * 平面作图：width × height 格的画布（原点左下角，y 向上，坐标可为小数）；grid 画方格（写 "dots" 画点阵：每个格点一个点，在点阵上连线画图形），axes 在底边与左边标 0、1、2……（数对、坐标），compass 画指北箭头。
   * grid 写 "iso" 画等距点阵（画正方体、长方体的立体图）：点排成竖列，相邻两点都相隔一格；x 数第几列（整数，0 到 width），y 数往上第几个点，
   * 偶数列（0、2、4……）的点在整数高度，奇数列的点错开半格（0.5、1.5……）。斜着走一格 x 加减 1、y 加减 0.5，竖着走一格 y 加减 1：
   * 如长方体前面最下的角在 [2, 0]，往右上长 3 格到 [5, 1.5]，往左上宽 2 格到 [0, 1]，高 2 格各加 [0, 2]。形状的顶点、线的两端与点都要落在点上；不能和 axes 同用。
   * shapes 多边形：points 依次为各顶点；sides[i] 标在第 i 条边（points[i] 到下一点）外侧，angles[i] 标在第 i 个顶点的内角里，right 为画直角记号的顶点序号，names 为顶点字母；
   * open 为不封口的折线（如 N–O–A 标方向角、两条路的夹角），只在中间的顶点标角。
   * label 默认写在各顶点的平均位置，凹多边形（L 形）可用 labelAt 指定位置。
   * lines 线：kind 为 plain（缺省）、segment（两端画点）、ray（起点画点、终点箭头）、line（两端箭头）、arrow（移动方向）；foot 在终点画垂足的直角记号（画高）。
   * circles 圆：radius／diameter 写了就画出半径或直径并标上；points 点：标字母或说明。填色见 Fill，挖空的最后画。
   * axes 时可写 xLabel／yLabel（轴名）与 xStep／yStep（每格代表几，轴上标 0、xStep、2×xStep……；坐标仍按格算）；texts 在某处只写字、不画点（候选图的 A／B／C、树状图的数）。
   * 四个象限（六年级）：origin [ox, oy] 把原点放在离左边 ox 格、离底边 oy 格处（整数），x、y 轴穿过原点、两端带箭头，刻度标 −3、−2……，
   * 轴端缺省写 x、y（xLabel／yLabel 可改）；这时所有坐标都按原点算、可以是负数：width 10、height 8、origin [5, 4] 的画布 x 从 −5 到 5、y 从 −4 到 4，
   * 点 [-3, 2] 就在第二象限。写了 origin 就不用再写 axes；不能和 grid: "iso" 同用。
   * parallel 标平行边：每组列几条边的序号（同 sides 的序号），第一组每条边中间画一个小箭头、第二组两个、第三组三个（同组的箭头同向），
   * 如平行四边形 [[0, 2], [1, 3]]；同组的边须真的平行。
   * 正多边形：形状不写 points、改写 regular { sides 边数 3–12（可写 "{n}"）, center 中心, r 中心到顶点的距离, rotate?, spokes? }：
   * 缺省底边水平，顶点从底边左端起逆时针排（第 0 条边是底边）；rotate 再逆时针转几度；spokes 为 true 时画出中心到各顶点的辐条（讲对称轴、旋转对称）。
   */
  | {
    type: "plane"; width: Num; height: Num; grid?: boolean | "dots" | "iso"; axes?: boolean; compass?: boolean; xLabel?: string; yLabel?: string; xStep?: Num; yStep?: Num; origin?: [Num, Num];
    shapes?: PlaneShape[];
    lines?: { from: Pt; to: Pt; kind?: "plain" | "segment" | "ray" | "line" | "arrow"; dashed?: boolean; label?: string; color?: Color; foot?: boolean }[];
    circles?: { center: Pt; r: Num; color?: Color; fill?: Fill; dashed?: boolean; label?: string; radius?: Num; diameter?: Num }[];
    points?: { at: Pt; label?: string }[];
    texts?: { at: Pt; text: string }[];
  }
  /**
   * 立体图形（带尺寸）：length／width／height／radius／diameter 为标在图上的尺寸（如 "8 cm"，数值同时决定画出来的比例）；
   * units 为 [长, 宽, 高] 个小正方体（只用于 cuboid／cube，画出单位小方块）；label 写在图下；
   * water 为水深（如 "6 cm"，只用于 cuboid／cube／cylinder，按与 height 的比例画出水面并标上）。
   * prism 是三棱柱（横放，三角形的面在右端）：length 为棱柱的长，width 为三角形的底，height 为三角形的高。
   * sides（只用于 prism，3–8，缺省 3）画正 n 边形底的直棱柱（铅笔写 sides: 6）：躺在一个侧面上，一个底面正对着看的人、画成正多边形，
   * 长往右后方斜着伸进去（同长方体的进深）；length 为棱柱的长（标在右下那条往后伸的棱旁），width 为底面正多边形的边长（标在前面底边下），
   * 不写 height（正多边形的高由边长定）；没写 width 时底面约为长的一半宽。
   * mark 标出面、棱或顶点（只用于 cube／cuboid／prism／pyramid）：faces 看得见的各面涂不同浅色，edges 棱加粗上色（看不见的虚线），
   * vertices 在各顶点画点（看不见的淡一些）
   */
  | { type: "solid"; shape: "cuboid" | "cube" | "cylinder" | "cone" | "sphere" | "pyramid" | "prism"; length?: Num; width?: Num; height?: Num; radius?: Num; diameter?: Num; units?: [Num, Num, Num]; color?: Color; label?: string; water?: Num; mark?: "faces" | "edges" | "vertices"; sides?: Num }
  /** 小正方体堆（观察物体、数体积）：layout 是俯视图，第一行在最后面、最后一行在最前面，每格写这一摞有几个（0–5）；最多 5 行 8 列（两堆可在中间空一列） */
  | { type: "cubes"; layout: Num[][]; color?: Color }
  /**
   * 直尺：长 length 个单位（cm、m、in 英寸或 ft 英尺），start 为起点读数（缺省 0，如量身高画 110 到 140）；minor 为每个单位再分几小格：
   * cm／m 可写 2、4、5、10（cm 尺写 10 即毫米刻度），in 可写 2、4、8（半英寸、四分之一、八分之一，刻度线逐级变短），ft 可写 2、4、12（12 即英寸刻度，3 ft 的尺就是一码）；
   * items 为摆在尺上方的东西（从 from 到 to，按尺上的读数，可为小数如 2.25）
   */
  | { type: "ruler"; length: Num; start?: Num; unit?: "cm" | "m" | "in" | "ft"; minor?: Num; items?: { from: Num; to: Num; label?: string; color?: Color; icon?: Icon }[] }
  /** 量具：scale 秤（圆表盘）、jug 量杯、thermometer 温度计（min 可为负）；刻度 min–max 每 step 一格，指针或液面在 value；labelEvery 每几格标一个数 */
  | { type: "gauge"; kind: "scale" | "jug" | "thermometer"; min?: Num; max: Num; step: Num; value: Num; unit: string; labelEvery?: Num; label?: string }
  /** 日历：某年某月的月历（按真实星期排），highlight 圈出某几天，missing 里的日子写成 ? */
  | { type: "calendar"; year: Num; month: Num; highlight?: Num[]; missing?: Num[] }
  /**
   * 时间线（经过时间）：from／to 为 "8:30" 这样的时刻（分可以超过 59，自动进位，便于写 "{h}:{m+d}"），step 为每格几分钟；
   * to 早于 from 表示跨过午夜到第二天（如 "22:00" 到 "2:00"，这时比 from 早的时刻都算第二天）；
   * marks 标出几个时刻（写 { at, label } 可把时刻换成自己的标签，如 "?"、"start"），jumps 画从一个时刻到另一个时刻的弧线（label 如 "45 min"）；format 为 12h（缺省）或 24h
   */
  | { type: "timeline"; from: string; to: string; step?: Num; marks?: (string | { at: string; label?: string })[]; jumps?: { from: string; to: string; label?: string }[]; format?: "12h" | "24h" }
  /** 集合圈（韦恩图）：两个相交的圈，各区写人数或几个名字，"?" 为待求；leftTotal／rightTotal 为整圈的总数（写在圈名下），neither 为两圈外，total 写在外框上（如 "Class: 40"） */
  | { type: "venn"; left: string; right: string; leftOnly: Num; both: Num; rightOnly: Num; leftTotal?: Num; rightTotal?: Num; neither?: Num; total?: string }
  /**
   * 面积模型（格子乘法、分配律、面积拆分）：长方形按列宽 cols、行高 rows 切成小块（1–4 列、1–3 行，按数值比例画，太窄的块会放宽），
   * 顶上标各列的数、左边标各行的数；cells[行][列] 为每块里写的数（缺省写乘积，"?" 为待求，null 留空）；
   * unit 为长度单位（面积题用，mm／cm／m／km）：边上写 8 cm、块里写 48 cm²
   */
  | { type: "areaModel"; cols: Num[]; rows: Num[]; cells?: (Num | null)[][]; unit?: "mm" | "cm" | "m" | "km" }
  /**
   * 中国算盘（上二下五）：number 为 0–99,999 的整数，每档靠梁的上珠至多 1 颗（当 5）、下珠至多 4 颗（各当 1），不用的珠子靠框；
   * 某几档待求时 number 写成数字串（如 "3?5"），这几档用 ? 盖住；整个数待求写 "?"：珠子全部靠框（空盘），梁下写 ?（请孩子拨出这个数）。
   * rods 为档数（缺省按位数、至少 3，最多 6）；labels 在档下写 Ones、Tens、Hundreds……
   */
  | { type: "suanpan"; number: Num; rods?: Num; labels?: boolean }
  /**
   * 计数符号统计表：每行一个类别，count 0–40 画成计数符号（每 5 个一组：四竖一斜划）；title 写在表上方；
   * totals 加一列 Total 写数，hide 为从 0 数起的几行（这几行的 Total 写 ?）；plain 为一样一竖、不按五个一组（学前「自己做记号」）
   */
  | { type: "tally"; rows: { label: string; count: Num }[]; title?: string; totals?: boolean; hide?: number[]; plain?: boolean }
  /** 手指：每只手竖起几根（0–5：1 是食指，2 加中指，3 加无名指，4 是四指，5 连拇指），1–4 只手；换拍时手指竖起或收起 */
  | { type: "fingers"; hands: Num[] }
  /**
   * 骰子面或点卡（一眼看出几个、掷骰子）：faces 每项 1–6，按骰子的点型画；card 为 true 画成点卡，可到 10（7 是六点加中间一点，8、10 两列，9 三行三列）；
   * "?" 画成空白面写 ?；highlight 为从 1 数起第几个画圈
   */
  | { type: "dice"; faces: Num[]; card?: boolean; highlight?: number[] }
  /**
   * 硬币（掷硬币的试验）：faces 每项是 "H"（正面，画一个简单的头像）、"T"（反面，画一颗星）或 "?"（还没看到，画成灰色写 ?），1–10 枚，
   * 每枚下面写 H 或 T；highlight 为从 1 数起第几枚画圈。不画任何国家的真实币面；换拍时改了的那枚翻过去，新加的弹出
   */
  | { type: "coins"; faces: ("H" | "T" | "?")[]; highlight?: number[] }
  /**
   * 流程图：2–7 步，按顺序写（程序按板上的地方排：竖排一列，或没有分支时从左到右排成几行；问题的 Yes 接一个结束框时可把它画在问题右边）；
   * kind 为 start／end（圆角框）、step（方框，缺省）、question（菱形）。每步缺省接下一步（end 不接）；
   * question 的 yes 缺省接下一步，yes／no 可指向第几步（从 0 数起，可往回指成循环），不接下一步的那一支画在一侧的折线箭头上，标 Yes／No；
   * start／step 的 next 指向第几步（从 0 数起），不是下一步时也画在侧边（不标字）：如「是就放 A 盒、否就放 B 盒、再汇合到同一个结束框」写成
   * 问题 no 指向 B 盒，A 盒排在问题下面、next 指向结束框，B 盒排在 A 盒下面、接着结束框。侧边各条折线自动分到左右两侧、由里往外排，互不交叉
   */
  | { type: "flow"; steps: { text: string; kind?: "start" | "step" | "question" | "end"; yes?: number; no?: number; next?: number }[] }
  /** 算式或一句话（可含模板；"3/4" 这样的分数显示成上下排的分数） */
  | { type: "text"; text: string };

export type WidgetType = Widget["type"];

export const WIDGET_TYPES: WidgetType[] = [
  "objects", "equalGroups", "array", "tenFrame", "numberBond", "numberLine", "placeValue", "placeChart", "barModel", "shapes", "clock",
  "money", "pattern", "lengths", "balance", "grid", "pictureGraph", "hundredChart", "column", "division", "fraction", "pie", "barChart",
  "lineGraph", "table", "angle", "plane", "solid", "cubes", "ruler", "gauge", "calendar", "timeline", "venn", "areaModel",
  "suanpan", "tally", "flow", "dice", "coins", "fingers", "boxPlot", "text",
];

/** 算盘的数位（从个位起），档下的名字也用它 */
export const SUANPAN_PLACES = ["ones", "tens", "hundreds", "thousands", "ten thousands", "hundred thousands"] as const;
/** 算盘各档的数字（从最高档到个位，共 rods 档）：number 为数、"?"（返回 null）或含 ? 的数字串（那几档为 "?"） */
export function suanpanDigits(number: Num, rods: number): (number | "?")[] | null {
  if (number === "?") return null;
  const s = typeof number === "number" ? String(Math.round(number)) : String(number);
  return Array.from({ length: rods }, (_, i) => {
    const ch = s[s.length - rods + i];
    return ch === undefined ? 0 : ch === "?" ? "?" : Number(ch);
  });
}
/** 算盘缺省的档数：按位数，至少 3 */
export const suanpanRods = (w: { number: Num; rods?: Num }) =>
  typeof w.rods === "number" ? w.rods : Math.max(3, w.number === "?" ? 0 : String(typeof w.number === "number" ? Math.round(w.number) : w.number).length);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 小数位数（按十进制写法数，最多看 6 位） */
export function decimalPlaces(v: number): number {
  const s = String(Math.round(Math.abs(v) * 1e6) / 1e6);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** 数轴上的位置：数，或分数写法 "3/4"、"1 1/2"、"-2/3"、"0.5"；看不懂返回 null */
export function parsePosition(v: unknown): number | null {
  if (isNum(v)) return v;
  if (typeof v !== "string") return null;
  const m = /^(-)?(?:(\d+)\s+)?(\d+)\/(\d+)$/.exec(v.trim());
  if (m) {
    const den = Number(m[4]);
    if (!den) return null;
    const val = Number(m[2] ?? 0) + Number(m[3]) / den;
    return m[1] ? -val : val;
  }
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
}

/** 时刻 "8:30"、"8:5"（宽松：分可以超过 59，自动进位）→ 从 0 点起的分钟；不合规或超过 24:00 返回 null */
export function parseTime(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{1,3})$/.exec(v.trim());
  if (!m) return null;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return t <= 24 * 60 ? t : null;
}

/** 分钟 → 时刻文字：12h 按新加坡课堂写法 8.30 a.m.（整 12 点写 12 noon、12 midnight），24h 写 08:30；period=false 时 12h 不带 a.m.／p.m. */
export function timeText(t: number, format: "12h" | "24h" = "12h", period = true): string {
  const m = ((Math.round(t) % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
  if (format === "24h") return `${String(h).padStart(2, "0")}:${mm}`;
  if (period && m % 60 === 0 && h % 12 === 0) return h === 12 ? "12 noon" : "12 midnight";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}.${mm}${period ? (h < 12 ? " a.m." : " p.m.") : ""}`;
}

/** 某月有几天（公历，含闰年） */
export const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

/** 正多边形的顶点：缺省底边水平，从底边左端起逆时针排，rotate 再逆时针转几度；参数不是数（模板未出数）时返回 null */
export function regularPoints(g: Regular): Pt[] | null {
  const k = g.sides, r = g.r, c = g.center, rot = g.rotate ?? 0;
  if (!isNum(k) || !isNum(r) || !Array.isArray(c) || !isNum(c[0]) || !isNum(c[1]) || !isNum(rot) || !Number.isInteger(k) || k < 3) return null;
  const cx = c[0], cy = c[1];
  return Array.from({ length: k }, (_, i) => {
    const a = ((-90 - 180 / k + (i * 360) / k + rot) * Math.PI) / 180;
    // 留四位小数：浮点尾巴不影响画，也不让板面说明写出一长串
    return [Math.round((cx + r * Math.cos(a)) * 1e4) / 1e4, Math.round((cy + r * Math.sin(a)) * 1e4) / 1e4];
  });
}

/** 立体图的斜投影（长方体、棱柱、棱锥共用）：进深按一半长度、朝右上 35° 画 */
export const OBLIQUE = { k: 0.5, angle: 35 } as const;

/**
 * 正 n 棱柱（solid 的 prism 写 sides 4–8）：躺在一个侧面上，一个底面正对着看的人（画成真正的正多边形），长往右后方斜着伸进去（同长方体的进深）。
 * angle 为进深斜着伸去的角度；base 为底面各顶点 [u, v]（中心到顶点的距离为 1；u 以中心为 0、往右为正，v 从底边起往上），底边水平，从底边左端起逆时针排；
 * lateral[i] 为第 i 个侧面（顶点 i 到 i+1 那条边往后拉出的长方形）在斜投影下看不看得见；前面的底面看得见，后面的看不见。
 * 画板（web/src/lesson/board/upper.tsx）与板面说明共用这一份，看得见、看不见的面、棱、顶点两边一致
 */
export function prismView(sides: number) {
  // 进深斜着伸去的角度：缺省同长方体 35°；五、七、八棱柱在 35° 时有个侧面几乎侧着对人（画出来只剩一条缝、前后顶点叠在一起），各换一个角度
  const k = Math.max(3, Math.round(sides)), angle = ({ 5: 24, 7: 38, 8: 30 } as Record<number, number>)[k] ?? OBLIQUE.angle, tilt = (angle * Math.PI) / 180;
  const th = (i: number) => ((270 - 180 / k + (i * 360) / k) * Math.PI) / 180;
  const v0 = Math.sin(th(0));
  const base = Array.from({ length: k }, (_, i): [number, number] => [Math.cos(th(i)), Math.sin(th(i)) - v0]);
  // 侧面 i 的外法线朝 θ_i + 180°/n；朝右上（进深伸去的那一边）的看得见
  const lateral = Array.from({ length: k }, (_, i) => Math.cos(th(i) + Math.PI / k - tilt) > 1e-9);
  // 看不见的：面为看不见的侧面加后面的底面；棱为后面底面上挨着看不见的侧面的边，加两旁侧面都看不见的侧棱；顶点为后面底面上两旁侧面都看不见的
  const backCorner = (j: number) => !lateral[(j + k - 1) % k] && !lateral[j];
  const hiddenSides = lateral.filter((v) => !v).length, backCorners = base.filter((_, j) => backCorner(j)).length;
  return { base, lateral, backCorner, angle, faces: k + 2, edges: 3 * k, vertices: 2 * k, hiddenFaces: hiddenSides + 1, hiddenEdges: hiddenSides + backCorners, hiddenVertices: backCorners };
}

/** 平面图上一个形状的顶点：写了 points 就用，写了 regular 就按参数算（都没有为空） */
export const shapePoints = (s: PlaneShape): Pt[] => (Array.isArray(s.points) ? s.points : s.regular ? (regularPoints(s.regular) ?? []) : []);

/** 平面图的坐标范围：缺省原点在左下角（x 0…width，y 0…height）；写了 origin [ox, oy] 时 x 从 −ox 到 width − ox、y 从 −oy 到 height − oy */
export function planeRange(w: { width: Num; height: Num; origin?: [Num, Num] }): { x0: number; x1: number; y0: number; y1: number } {
  const W = isNum(w.width) ? w.width : 10, H = isNum(w.height) ? w.height : 6;
  const ox = isNum(w.origin?.[0]) ? w.origin[0] : 0, oy = isNum(w.origin?.[1]) ? w.origin[1] : 0;
  return { x0: -ox, x1: W - ox, y0: -oy, y1: H - oy };
}

/** 箱线图数轴每格多少：写了 step 就用；没写按 1、2、5、10、20、50……取第一个能整分 from–to、不超过 20 格的（都不行返回 null） */
export function boxStep(w: { from: Num; to: Num; step?: Num }): number | null {
  if (w.step !== undefined) return isNum(w.step) && w.step > 0 ? w.step : null;
  if (!isNum(w.from) || !isNum(w.to) || w.to <= w.from) return null;
  for (let p = 1e-3; p <= 1e6; p *= 10) for (const k of [1, 2, 5]) {
    const s = Math.round(k * p * 1e6) / 1e6, n = (w.to - w.from) / s;
    if (n <= 20 + 1e-9 && Math.abs(n - Math.round(n)) < 1e-6) return s;
  }
  return null;
}

/**
 * 把一个数拆到各数位（从高到低）。places 缺省：从最高非零位（至少到个位）到最低非零小数位。
 * 数超出位值表或小数多于三位时返回 null。
 */
export function placeDigits(n: number, places?: readonly Place[]): { place: Place; digit: number }[] | null {
  if (!isNum(n) || n < 0 || n >= 1e9) return null;
  const scaled = Math.round(n * 1000);
  if (Math.abs(scaled - n * 1000) > 1e-6) return null;
  const digitAt = (p: Place) => Math.floor(scaled / 10 ** (placePower(p) + 3)) % 10;
  let list: Place[];
  if (places?.length) list = PLACES.filter((p) => places.includes(p));
  else {
    const top = PLACES.findIndex((p) => placePower(p) >= 0 && digitAt(p) !== 0);
    const hi = top < 0 || placePower(PLACES[top]) < 0 ? PLACES.indexOf("ones") : top;
    const decimals = (["thousandths", "hundredths", "tenths"] as Place[]).find((p) => digitAt(p) !== 0);
    const lo = decimals ? PLACES.indexOf(decimals) : PLACES.indexOf("ones");
    list = PLACES.slice(hi, lo + 1) as Place[];
  }
  // 显示的数位要装得下这个数：比最高位还高、比最低位还低的非零数字都算装不下
  const shown = new Set(list);
  for (const p of PLACES) if (!shown.has(p) && digitAt(p) !== 0) return null;
  return list.map((place) => ({ place, digit: digitAt(place) }));
}

/** 长除法（整数除数）：商与余数，以及按位除的每一步（working 用）。places 为商算到第几位小数 */
export function longDivision(dividend: number, divisor: number, places: number) {
  const scale = 10 ** places;
  const whole = Math.round(dividend * scale);
  const quotient = Math.floor(whole / divisor), rest = whole - quotient * divisor;
  const digits = String(whole).split("").map(Number);
  // 每一步：到第 end 位（从 0 数）为止的部分被除数 part，商这一位 q，减去 product，得 left；只记商已开始后的步骤
  const steps: { end: number; part: number; q: number; product: number; left: number }[] = [];
  let cur = 0, started = false;
  digits.forEach((d, i) => {
    cur = cur * 10 + d;
    const q = Math.floor(cur / divisor);
    if (q > 0 || started) {
      started = true;
      steps.push({ end: i, part: cur, q, product: q * divisor, left: cur - q * divisor });
    }
    cur -= q * divisor;
  });
  return { quotient: quotient / scale, remainder: rest / scale, steps, whole };
}

/**
 * 校验一块已出数的显示板（数值都已是数字或 "?"）：类型认识、数量在显示板摆得下的范围里。返回问题列表（空 = 通过）。
 */
export function checkBoard(board: unknown, where: string): string[] {
  const errs: string[] = [];
  const bad = (m: string) => errs.push(`${where}: ${m}`);
  if (!Array.isArray(board) || board.length < 1 || board.length > 3) {
    bad("the board must have 1–3 diagrams");
    return errs;
  }
  const num = (v: unknown, label: string, min: number, max: number, unknownOk = false) => {
    if (v === "?" && unknownOk) return;
    if (!isNum(v)) return bad(`${label} must be a number${unknownOk ? " or \"?\"" : ""}, got ${JSON.stringify(v)}`);
    if (v < min || v > max) bad(`${label}=${v} is outside ${min}–${max}`);
  };
  const int = (v: unknown, label: string, min: number, max: number) => {
    num(v, label, min, max);
    if (isNum(v) && !Number.isInteger(v)) bad(`${label} must be an integer, got ${v}`);
  };
  /** 标签：短文字或数，"?" 也行 */
  const txt = (v: unknown, label: string, max: number) => {
    if (isNum(v)) return;
    if (typeof v !== "string" || !v.trim() || v.length > max) bad(`${label} must be 1–${max} characters, got ${JSON.stringify(v)}`);
  };
  const oneOf = (v: unknown, label: string, list: readonly unknown[]) => { if (v !== undefined && !list.includes(v)) bad(`${label} must be one of ${list.join(", ")}, got ${JSON.stringify(v)}`); };
  const icon = (v: unknown, label: string) => { if (!ICONS.includes(v as Icon)) bad(`${label}: ${JSON.stringify(v)} is not a known icon`); };
  const color = (v: unknown, label: string) => { if (v !== undefined && !COLORS.includes(v as Color)) bad(`${label}: ${JSON.stringify(v)} is not a known colour`); };
  /** 数值的小数最多三位（多了多半是算不尽或浮点误差） */
  const places3 = (v: unknown, label: string) => { if (isNum(v) && decimalPlaces(v) > 3) bad(`${label}=${v} has more than 3 decimal places`); };
  for (const [i, w] of (board as Widget[]).entries()) {
    const at = `Diagram ${i + 1} (${(w as { type?: string })?.type ?? "?"})`;
    switch (w?.type) {
      case "objects": {
        if (!Array.isArray(w.groups) || w.groups.length < 1 || w.groups.length > 4) { bad(`${at}: groups must have 1–4 entries`); break; }
        let total = 0;
        for (const g of w.groups) { icon(g.icon, `${at} icon`); num(g.count, `${at} count`, 0, 30); total += isNum(g.count) ? g.count : 0; }
        if (total > 40) bad(`${at}: ${total} objects in total, too many for the board (≤ 40)`);
        for (const h of w.highlight === undefined ? [] : Array.isArray(w.highlight) ? w.highlight : [w.highlight]) num(h, `${at} highlight`, 1, 30);
        if (w.layout !== undefined && !["scatter", "row", "rows", "groups"].includes(w.layout)) bad(`${at}: layout must be one of scatter, row, rows, groups`);
        if (w.front !== undefined && !["left", "right"].includes(w.front)) bad(`${at}: front must be left or right`);
        if (w.numberedFrom !== undefined) int(w.numberedFrom, `${at} numberedFrom`, 1, Math.max(1, total));
        if (w.numbered !== undefined) int(w.numbered, `${at} numbered`, 0, Math.max(0, total - (isNum(w.numberedFrom) ? w.numberedFrom - 1 : 0)));
        if (w.ring !== undefined) txt(w.ring, `${at} ring`, 12);
        if (w.pairs !== undefined) {
          if (w.layout !== "rows" || w.groups.length < 2) bad(`${at}: pairs needs layout "rows" with at least 2 groups`);
          else int(w.pairs, `${at} pairs`, 0, Math.min(...w.groups.slice(0, 2).map((g) => (isNum(g.count) ? g.count : 30))));
        }
        break;
      }
      case "equalGroups": num(w.groups, `${at} groups`, 1, 10); num(w.perGroup, `${at} perGroup`, 1, 12); icon(w.icon, `${at} icon`); if (w.extra !== undefined) int(w.extra, `${at} extra`, 0, 12); break;
      case "array":
        num(w.rows, `${at} rows`, 1, 10); num(w.cols, `${at} cols`, 1, 12); icon(w.icon, `${at} icon`);
        if (w.split?.cols !== undefined) int(w.split.cols, `${at} split.cols`, 1, isNum(w.cols) ? Math.max(1, w.cols - 1) : 11);
        if (w.split?.rows !== undefined) int(w.split.rows, `${at} split.rows`, 1, isNum(w.rows) ? Math.max(1, w.rows - 1) : 9);
        break;
      case "tenFrame": {
        num(w.filled, `${at} filled`, 0, (w.frames ?? 1) * 10);
        if (w.icon !== undefined) icon(w.icon, `${at} icon`);
        if (w.glow !== undefined && !["row", "frame", "empty"].includes(w.glow)) bad(`${at}: glow must be row, frame or empty`);
        if (w.numbered !== undefined) {
          if (!Array.isArray(w.numbered) || w.numbered.length !== 2) bad(`${at}: numbered must be [from, to]`);
          else {
            const filled = isNum(w.filled) ? w.filled : 20;
            int(w.numbered[0], `${at} numbered from`, 1, filled);
            int(w.numbered[1], `${at} numbered to`, isNum(w.numbered[0]) ? w.numbered[0] : 1, filled);
          }
        }
        break;
      }
      case "numberBond": num(w.whole, `${at} whole`, 0, 1_000_000, true); places3(w.whole, `${at} whole`); if (!Array.isArray(w.parts) || w.parts.length !== 2) bad(`${at}: parts must have exactly 2 entries`); else w.parts.forEach((p, k) => { if (p === "") return; num(p, `${at} parts[${k}]`, 0, 1_000_000, true); places3(p, `${at} parts[${k}]`); }); break;
      case "numberLine": {
        num(w.from, `${at} from`, -1e9, 1e9); num(w.to, `${at} to`, -1e9, 1e9);
        if (w.denominator !== undefined) {
          int(w.denominator, `${at} denominator`, 2, 12);
          if (w.step !== undefined) bad(`${at}: step cannot be used with denominator (fraction ticks)`);
        } else num(w.step ?? 1, `${at} step`, 0.001, 1e8);
        if (w.simplify !== undefined && (typeof w.simplify !== "boolean" || w.denominator === undefined)) bad(`${at}: simplify must be true or false and needs denominator`);
        const step = w.denominator !== undefined ? (isNum(w.denominator) ? 1 / w.denominator : NaN) : (w.step ?? 1);
        let lo = -Infinity, hi = Infinity;
        if (isNum(w.from) && isNum(w.to) && isNum(step) && step > 0) {
          lo = w.from; hi = w.to;
          const ticks = (w.to - w.from) / step;
          if (w.to <= w.from) bad(`${at}: to must be greater than from`);
          else if (ticks > 30 + 1e-9) bad(`${at}: more than 30 intervals, too many for the board (use a larger step or a smaller range)`);
          else if (Math.abs(ticks - Math.round(ticks)) > 1e-6) bad(`${at}: the range from–to must be a whole number of intervals (a multiple of step)`);
        }
        if (w.labelEvery !== undefined) int(w.labelEvery, `${at} labelEvery`, 1, 30);
        if (w.years !== undefined && typeof w.years !== "boolean") bad(`${at}: years must be true or false`);
        const pos = (v: unknown, label: string) => {
          const p = parsePosition(v);
          if (p === null) bad(`${label} must be a number or fraction (e.g. "3/4"), got ${JSON.stringify(v)}`);
          else if (p < lo - 1e-9 || p > hi + 1e-9) bad(`${label}=${JSON.stringify(v)} is not on the number line ${lo}–${hi}`);
        };
        for (const m of w.marks ?? []) pos(m, `${at} marks`);
        for (const h of w.hidden ?? []) pos(h, `${at} hidden`);
        for (const j of w.jumps ?? []) { pos(j.from, `${at} jumps.from`); pos(j.to, `${at} jumps.to`); if (j.label !== undefined) txt(j.label, `${at} jumps.label`, 14); }
        for (const l of w.labels ?? []) { pos(l.at, `${at} labels.at`); txt(l.text, `${at} labels.text`, 12); }
        if (w.dots !== undefined) {
          if (!Array.isArray(w.dots) || w.dots.length > 31) bad(`${at}: dots must be a list of at most 31 positions`);
          else {
            for (const d of w.dots) { pos(d?.at, `${at} dots.at`); int(d?.count, `${at} dots.count`, 0, 12); }
            const spots = w.dots.map((d) => parsePosition(d?.at));
            if (spots.some((p, k) => p !== null && spots.findIndex((q) => q !== null && Math.abs(q - p) < 1e-9) !== k)) bad(`${at}: each position in dots can appear only once (put all the dots there in one count)`);
          }
        }
        oneOf(w.dotStyle, `${at} dotStyle`, ["dot", "x"]);
        // 不等式的解集：一个圈加一条射线，或两端各一个圈的线段；空心、实心必须写明
        if (w.ray !== undefined && w.segment !== undefined) bad(`${at}: use either ray or segment, not both`);
        if (w.ray !== undefined) {
          if (!w.ray || typeof w.ray !== "object") bad(`${at}: ray must be { at, dir, open }`);
          else {
            pos(w.ray.at, `${at} ray.at`);
            if (!["left", "right"].includes(w.ray.dir)) bad(`${at}: ray.dir must be "left" or "right"`);
            if (typeof w.ray.open !== "boolean") bad(`${at}: ray.open must be true (open circle: > or <, the number is not included) or false (filled circle: ≥ or ≤, the number is included)`);
          }
        }
        if (w.segment !== undefined) {
          if (!w.segment || typeof w.segment !== "object") bad(`${at}: segment must be { from, to, openFrom, openTo }`);
          else {
            pos(w.segment.from, `${at} segment.from`); pos(w.segment.to, `${at} segment.to`);
            const a = parsePosition(w.segment.from), b = parsePosition(w.segment.to);
            if (a !== null && b !== null && b <= a) bad(`${at}: segment.to must be greater than segment.from`);
            for (const key of ["openFrom", "openTo"] as const) if (typeof w.segment[key] !== "boolean") bad(`${at}: segment.${key} must be true (open circle, not included) or false (filled circle, included)`);
          }
        }
        break;
      }
      // 积木可以多到 19（10 块凑一条、10 条凑一块百板的前一拍）；数位表与算盘每位 0–9
      case "placeValue": if (w.hundreds !== undefined) num(w.hundreds, `${at} hundreds`, 0, 9, true); num(w.tens, `${at} tens`, 0, (w.style ?? "blocks") === "blocks" ? 19 : 9, true); num(w.ones, `${at} ones`, 0, (w.style ?? "blocks") === "blocks" ? 19 : 9, true); break;
      case "placeChart": {
        num(w.number, `${at} number`, 0, 999_999_999.999);
        for (const p of [...(w.places ?? []), ...(w.hide ?? [])]) if (!PLACES.includes(p)) bad(`${at}: ${JSON.stringify(p)} is not a known place (available: ${PLACES.join(", ")})`);
        oneOf(w.style, `${at} style`, ["chart", "discs"]);
        if (isNum(w.number)) {
          const digits = placeDigits(w.number, w.places);
          if (!digits) bad(`${at}: ${w.number} does not fit in ${w.places ? "the listed places" : "the place value chart (under 1 billion, at most 3 decimal places)"}`);
          else {
            if (w.hide?.some((p) => !digits.some((d) => d.place === p))) bad(`${at}: every place in hide must be one of the places shown`);
            if (w.style === "discs" && digits.length > 5) bad(`${at}: discs can show at most 5 places (got ${digits.length}); use chart for more`);
          }
        }
        break;
      }
      case "barModel": {
        if (!Array.isArray(w.bars) || w.bars.length < 1 || w.bars.length > 3) { bad(`${at}: bars must have 1–3 entries`); break; }
        for (const b of w.bars) {
          if (!Array.isArray(b.parts) || b.parts.length < 1 || b.parts.length > 10) bad(`${at}: each bar must have 1–10 parts`);
          else for (const p of b.parts) {
            if (p.size !== undefined) num(p.size, `${at} part size`, 0.01, 1_000_000);
            if (p.value === "") continue;
            if (typeof p.value === "string" && p.value !== "?") txt(p.value, `${at} part text`, 10);
            else { num(p.value, `${at} part`, 0, 1_000_000, true); places3(p.value, `${at} part`); }
          }
        }
        if (w.total !== undefined) {
          if (typeof w.total === "string" && w.total !== "?") txt(w.total, `${at} total text`, 12);
          else { num(w.total, `${at} total`, 0, 1_000_000, true); places3(w.total, `${at} total`); }
        }
        oneOf(w.totalSide, `${at} totalSide`, ["top", "right"]);
        break;
      }
      case "shapes":
        if (!Array.isArray(w.items) || w.items.length < 1 || w.items.length > 8) { bad(`${at}: items must have 1–8 entries`); break; }
        for (const s of w.items) {
          if (!SHAPES.includes(s.shape)) bad(`${at}: ${JSON.stringify(s.shape)} is not a known shape`);
          color(s.color, `${at}`);
          if (s.count !== undefined) num(s.count, `${at} count`, 1, 10);
        }
        for (const h of w.highlight ?? []) if (!Number.isInteger(h) || h < 1 || h > w.items.reduce((a, s) => a + (isNum(s.count) ? s.count : 1), 0)) bad(`${at}: highlight ${h} must count from 1 within the shapes`);
        if (w.items.reduce((a, s) => a + (isNum(s.count) ? s.count : 1), 0) > 40) bad(`${at}: at most 40 shapes in total`);
        break;
      case "clock": {
        oneOf(w.digital, `${at} digital`, ["12h", "24h"]);
        const h24 = w.digital === "24h";
        int(w.hour, `${at} hour`, h24 ? 0 : 1, h24 ? 23 : 12); int(w.minute, `${at} minute`, 0, 59);
        if (w.second !== undefined) int(w.second, `${at} second`, 0, 59);
        oneOf(w.period, `${at} period`, ["a.m.", "p.m."]);
        if (w.period && h24) bad(`${at}: period (a.m./p.m.) cannot be used with digital: "24h"`);
        if (w.roman !== undefined && typeof w.roman !== "boolean") bad(`${at}: roman must be true or false`);
        if (w.roman && w.digital) bad(`${at}: roman numerals are only for a clock face with hands (not digital)`);
        break;
      }
      case "money": {
        if (!Array.isArray(w.items) || w.items.length < 1 || w.items.length > 6) { bad(`${at}: items must have 1–6 entries`); break; }
        oneOf(w.currency, `${at} currency`, CURRENCIES);
        const set = MONEY[(CURRENCIES as readonly string[]).includes(w.currency ?? "") ? (w.currency as Currency) : "sgd"];
        const values = [...set.coins, ...set.notes];
        for (const m of w.items) {
          if (m.note) {
            if (![...set.notes, ...(set.paper ?? [])].includes(m.value as number)) bad(`${at}: value ${JSON.stringify(m.value)} has no ${w.currency ?? "sgd"} note (notes: ${[...(set.paper ?? []), ...set.notes].join(", ")})`);
          } else if (!values.includes(m.value as number)) bad(`${at}: value ${JSON.stringify(m.value)} is not a ${w.currency ?? "sgd"} coin or note (smallest units: ${values.join(", ")}${set.paper ? `; notes only with note: true: ${set.paper.filter((v) => !values.includes(v)).join(", ")}` : ""})`);
          num(m.count, `${at} count`, 1, 10);
        }
        break;
      }
      case "pattern":
        if (!Array.isArray(w.sequence) || w.sequence.length < 3 || w.sequence.length > 14) bad(`${at}: sequence must have 3–14 entries`);
        for (const m of w.missing ?? []) if (!Number.isInteger(m) || m < 0 || m >= (w.sequence?.length ?? 0)) bad(`${at}: missing position ${m} is not in the sequence`);
        for (const m of w.highlight ?? []) if (!Number.isInteger(m) || m < 0 || m >= (w.sequence?.length ?? 0)) bad(`${at}: highlight position ${m} is not in the sequence`);
        if (w.box !== undefined && !(Array.isArray(w.box) && w.box.length === 2 && Number.isInteger(w.box[0]) && Number.isInteger(w.box[1]) && w.box[0] >= 0 && w.box[1] >= 1 && w.box[0] + w.box[1] <= (w.sequence?.length ?? 0))) bad(`${at}: box must be [start, count] inside the sequence`);
        break;
      case "lengths":
        if (!Array.isArray(w.items) || w.items.length < 2 || w.items.length > 5) { bad(`${at}: items must have 2–5 entries`); break; }
        for (const l of w.items) {
          num(l.length, `${at} length`, 1, 100);
          if (l.start !== undefined) num(l.start, `${at} start`, 0, 50);
          if (l.icon !== undefined) icon(l.icon, `${at} icon`);
          color(l.color, `${at}`);
        }
        break;
      case "balance": if (typeof w.left !== "string" || typeof w.right !== "string" || (!w.left && !w.right) || !["left", "right", "same"].includes(w.heavier)) bad(`${at}: left and right are required ("" is an empty pan, but not both), and heavier must be left, right or same`); break;
      case "grid":
        num(w.rows, `${at} rows`, 1, 6); num(w.cols, `${at} cols`, 1, 8);
        if (!Array.isArray(w.items) || w.items.length < 1 || w.items.length > 12) { bad(`${at}: items must have 1–12 entries`); break; }
        for (const g of w.items) { icon(g.icon, `${at} icon`); num(g.row, `${at} row`, 1, 6); num(g.col, `${at} col`, 1, 8); }
        break;
      case "pictureGraph":
        if (!Array.isArray(w.categories) || w.categories.length < 2 || w.categories.length > 5) { bad(`${at}: categories must have 2–5 entries`); break; }
        for (const c of w.categories) {
          icon(c.icon, `${at} icon`); num(c.count, `${at} count`, 0, 12, true);
          if (isNum(c.count) && !Number.isInteger(c.count * 2)) bad(`${at}: count ${c.count} must be a whole number or end in .5 (half a picture)`);
        }
        if (w.scale !== undefined) int(w.scale, `${at} scale`, 2, 100);
        if (w.categories.some((c) => isNum(c.count) && !Number.isInteger(c.count)) && !(isNum(w.scale) && w.scale % 2 === 0)) bad(`${at}: half pictures need an even scale (so half a picture stands for a whole number)`);
        break;
      case "hundredChart":
        num(w.from ?? 1, `${at} from`, 0, 100); num(w.to ?? 100, `${at} to`, 1, 120);
        for (const h of [...(w.highlight ?? []), ...(w.missing ?? []), ...(w.crossed ?? []), ...(w.circled ?? [])]) num(h, `${at} highlight/missing/crossed/circled`, 0, 120);
        break;
      case "column": {
        /** 竖式里的一个数：数（至多三位小数）、"?"，或含 ? 的数字串（某几位待求，如 "4?7"） */
        const cell = (v: unknown, label: string, max: number) => {
          if (typeof v === "string" && v !== "?" && /^[\d?]+(\.[\d?]+)?$/.test(v)) { if (v.length > 10) bad(`${label} is too long`); return; }
          num(v, label, 0, max, true); places3(v, label);
        };
        cell(w.top, `${at} top`, 9_999_999); cell(w.bottom, `${at} bottom`, 9_999_999);
        if (w.result !== undefined) cell(w.result, `${at} result`, 99_999_999);
        if (!["+", "-", "×"].includes(w.op)) bad(`${at}: op must be +, - or ×`);
        if (w.op === "-" && isNum(w.top) && isNum(w.bottom) && w.bottom > w.top) bad(`${at}: for subtraction, top must not be less than bottom`);
        if (w.partials) {
          if (w.op !== "×") bad(`${at}: partials is only for multiplication (×)`);
          else if (!isNum(w.top) || !isNum(w.bottom) || !Number.isInteger(w.top) || !Number.isInteger(w.bottom) || w.bottom < 10 || w.bottom > 999) bad(`${at}: partials needs two integers, with bottom in 10–999`);
          else if (Array.isArray(w.partials)) {
            if (w.partials.length !== String(w.bottom).length) bad(`${at}: the partials array must have ${String(w.bottom).length} rows (ones first, then tens, and so on)`);
            for (const p of w.partials) cell(p, `${at} partials`, 99_999_999);
          }
        }
        if (w.carries !== undefined) {
          if ([w.top, w.bottom].some((v) => String(v).includes("."))) bad(`${at}: carries is only for whole numbers (no decimals)`);
          if (!Array.isArray(w.carries) || w.carries.length > 8) bad(`${at}: carries can have at most 8 columns`);
          else for (const c of w.carries) if (c !== null) num(c, `${at} carries`, 0, 19, true);
        }
        if (w.crossed !== undefined) {
          const digits = String(w.top).replace(".", "").length;
          if (!Array.isArray(w.crossed) || w.crossed.some((i) => !Number.isInteger(i) || i < 0 || i >= digits)) bad(`${at}: crossed lists digits of the top number by column (ones = 0), each less than ${digits}`);
        }
        break;
      }
      case "division": {
        num(w.dividend, `${at} dividend`, 0, 999_999); int(w.divisor, `${at} divisor`, 1, 99); places3(w.dividend, `${at} dividend`);
        oneOf(w.show, `${at} show`, ["question", "answer", "working"]);
        if (w.places !== undefined) int(w.places, `${at} places`, 0, 3);
        if (w.steps !== undefined) { int(w.steps, `${at} steps`, 1, 6); if (w.show !== "working") bad(`${at}: steps is only for show: "working"`); }
        if (w.last !== undefined) { oneOf(w.last, `${at} last`, ["digit", "product", "left"]); if (w.steps === undefined) bad(`${at}: last needs steps (how far the last shown step goes)`); }
        if (isNum(w.dividend) && isNum(w.divisor) && w.divisor >= 1) {
          const places = isNum(w.places) ? w.places : decimalPlaces(w.dividend);
          if (places < decimalPlaces(w.dividend)) bad(`${at}: places cannot be fewer than the number of decimal places in dividend`);
          const d = longDivision(w.dividend, w.divisor, places);
          if (String(d.whole).length > 7) bad(`${at}: the dividend with added zeros has more than 7 digits, too long for the board`);
          if (w.show === "working" && d.steps.length > 6) bad(`${at}: the working has ${d.steps.length} steps, too many for the board (≤ 6)`);
        }
        break;
      }
      case "fraction": {
        oneOf(w.shape, `${at} shape`, ["circle", "rectangle", "bar"]);
        int(w.parts, `${at} parts`, 1, w.shape === "circle" ? 12 : w.shape === "bar" ? 24 : 100);
        int(w.shaded, `${at} shaded`, 0, 500);
        if (w.rows !== undefined) {
          int(w.rows, `${at} rows`, 1, 10);
          if (w.shape !== "rectangle") bad(`${at}: rows is only for rectangle`);
          else if (isNum(w.parts) && isNum(w.rows) && w.parts % w.rows) bad(`${at}: parts must be divisible by rows`);
        }
        if (isNum(w.parts) && isNum(w.shaded) && w.parts > 0) {
          const wholes = Math.max(1, Math.ceil(w.shaded / w.parts));
          if (wholes > 5) bad(`${at}: shading ${w.shaded} parts needs ${wholes} wholes (at most 5)`);
          if (w.shape === "rectangle" && w.parts > 12 && wholes > 1) bad(`${at}: a rectangle with more than 12 parts (e.g. a hundred square) can only show one whole`);
          if (w.unequal && (w.parts < 2 || w.parts > 4 || w.shaded > w.parts)) bad(`${at}: unequal only draws one whole with 2–4 parts`);
        }
        if (w.label !== undefined) txt(w.label, `${at} label`, 12);
        color(w.color, `${at}`); color(w.color2, `${at}`);
        if (w.shaded2 !== undefined) {
          int(w.shaded2, `${at} shaded2`, 0, 100);
          if (isNum(w.parts) && isNum(w.shaded) && isNum(w.shaded2) && w.shaded + w.shaded2 > w.parts) bad(`${at}: shaded + shaded2 cannot exceed parts (the second colour is for one whole only)`);
          if (w.unequal) bad(`${at}: unequal cannot be used with shaded2`);
        }
        if (w.split !== undefined) {
          int(w.split, `${at} split`, 2, 6);
          if (w.unequal) bad(`${at}: unequal cannot be used with split`);
          if (w.shape === "rectangle" && isNum(w.parts) && w.parts > 12) bad(`${at}: a rectangle with more than 12 parts cannot use split`);
        }
        if (w.square && w.shape !== "rectangle") bad(`${at}: square is only for rectangle`);
        break;
      }
      case "pie": {
        if (!Array.isArray(w.slices) || w.slices.length < 2 || w.slices.length > 8) { bad(`${at}: slices must have 2–8 entries`); break; }
        for (const s of w.slices) { txt(s.label, `${at} label`, 16); num(s.value, `${at} value`, 0.001, 1e6); color(s.color, `${at}`); }
        oneOf(w.show, `${at} show`, ["percent", "fraction", "angle", "value", "none"]);
        for (const h of w.hide ?? []) if (!Number.isInteger(h) || h < 0 || h >= w.slices.length) bad(`${at}: hide position ${h} is not one of the slices`);
        if (w.title !== undefined) txt(w.title, `${at} title`, 40);
        break;
      }
      case "barChart":
      case "lineGraph": {
        const cats = w.type === "barChart" ? w.categories : w.labels;
        const [minCats, maxCats] = w.type === "barChart" ? [2, 8] : [2, 12];
        if (!Array.isArray(cats) || cats.length < minCats || cats.length > maxCats) { bad(`${at}: ${w.type === "barChart" ? "categories" : "labels"} must have ${minCats}–${maxCats} entries`); break; }
        for (const c of cats) txt(c, `${at} category`, 14);
        const maxSeries = w.type === "barChart" ? 3 : 2;
        if (!Array.isArray(w.series) || w.series.length < 1 || w.series.length > maxSeries) { bad(`${at}: series must have 1–${maxSeries} entries`); break; }
        const values: number[] = [];
        for (const s of w.series) {
          if (!Array.isArray(s.values) || s.values.length !== cats.length) { bad(`${at}: each series needs as many values as categories (${cats.length})`); continue; }
          for (const v of s.values) {
            num(v, `${at} value`, -1e6, 1e6, true);
            places3(v, `${at} value`);
            if (isNum(v)) values.push(v);
          }
          if (w.series.length > 1) txt(s.label, `${at} legend label`, 16);
          color(s.color, `${at}`);
        }
        const min = w.min ?? 0;
        if (w.type === "barChart" && values.some((v) => v < 0)) bad(`${at}: bar chart values cannot be negative`);
        // 条形图的 min：纵轴从这里起（不从 0 开始，画折断记号），条都要高过它
        if (w.type === "barChart" && w.min !== undefined) {
          num(w.min, `${at} min`, 0, 1e6);
          const lo = w.min;
          if (isNum(lo) && values.some((v) => v < lo - 1e-9)) bad(`${at}: some values are below min ${lo} (the bars start at min, so every value must be at least min)`);
          if (isNum(lo) && values.length && w.max === undefined && lo >= Math.max(...values)) bad(`${at}: min must be less than the largest value`);
        }
        if (w.max !== undefined || w.step !== undefined) {
          num(w.max, `${at} max`, -1e6, 1e6); num(w.step, `${at} step`, 0.001, 1e6); num(min, `${at} min`, -1e6, 1e6);
          const max = w.max, step = w.step;
          if (isNum(max) && isNum(step) && isNum(min) && step > 0) {
            const ticks = (max - min) / step;
            if (max <= min) bad(`${at}: max must be greater than min`);
            else if (ticks > 12 + 1e-9 || Math.abs(ticks - Math.round(ticks)) > 1e-6) bad(`${at}: the vertical axis from ${min} to ${max} in steps of ${step} must have a whole number of intervals, at most 12`);
            if (values.some((v) => v > max + 1e-9 || v < min - 1e-9)) bad(`${at}: some values are outside the vertical axis ${min}–${max}`);
          }
        }
        if (w.unit !== undefined) txt(w.unit, `${at} unit`, 16);
        if (w.title !== undefined) txt(w.title, `${at} title`, 40);
        if (w.labelEvery !== undefined) int(w.labelEvery, `${at} labelEvery`, 1, 12);
        if (w.type === "lineGraph" && w.numericX) {
          const xs = cats.map((c) => Number(c));
          if (xs.some((x) => !Number.isFinite(x))) bad(`${at}: with numericX, all labels must be numbers`);
          else if (xs.some((x, i) => i > 0 && x <= xs[i - 1])) bad(`${at}: with numericX, labels must be in increasing order`);
        }
        if (w.type === "lineGraph" && w.xTitle !== undefined) txt(w.xTitle, `${at} xTitle`, 24);
        if (w.type === "barChart" && w.histogram !== undefined) {
          if (typeof w.histogram !== "boolean") bad(`${at}: histogram must be true or false`);
          else if (w.histogram && (w.series.length !== 1 || w.horizontal)) bad(`${at}: histogram needs exactly one series and cannot be horizontal`);
        }
        if (w.refLine !== undefined) {
          num(w.refLine?.value, `${at} refLine.value`, -1e6, 1e6); places3(w.refLine?.value, `${at} refLine.value`);
          if (w.refLine?.label !== undefined) txt(w.refLine.label, `${at} refLine.label`, 16);
        }
        break;
      }
      case "table": {
        if (!Array.isArray(w.rows) || w.rows.length < 1 || w.rows.length > 11) { bad(`${at}: rows must have 1–11 entries`); break; }
        const cols = w.header?.length ?? w.rows[0]?.length ?? 0;
        if (cols < 1 || cols > 11) bad(`${at}: must have 1–11 columns`);
        if (w.header !== undefined && !Array.isArray(w.header)) bad(`${at}: header must be an array`);
        for (const [r, row] of [...(w.header ? [w.header] : []), ...w.rows].entries()) {
          if (!Array.isArray(row) || row.length !== cols) { bad(`${at}: row ${r + 1} must have as many cells as there are columns (${cols})`); continue; }
          for (const cell of row) {
            if (isNum(cell)) places3(cell, `${at} cell`);
            else if (typeof cell !== "string" || cell.length > 16) bad(`${at}: each cell must be a number or text of up to 16 characters, got ${JSON.stringify(cell)}`);
          }
        }
        for (const h of w.highlight ?? []) if (!Array.isArray(h) || h.length !== 2 || !(h[0] >= (w.header ? -1 : 0) && h[0] < w.rows.length && h[1] >= 0 && h[1] < cols)) bad(`${at}: highlight ${JSON.stringify(h)} is outside the table (row -1 is the header)`);
        if (w.title !== undefined) txt(w.title, `${at} title`, 40);
        break;
      }
      case "angle":
        num(w.degrees, `${at} degrees`, 1, 360); places3(w.degrees, `${at} degrees`);
        if (w.turn !== undefined) num(w.turn, `${at} turn`, 0, 359);
        if (w.label !== undefined) txt(w.label, `${at} label`, 8);
        if (w.protractor && isNum(w.degrees) && w.degrees > 180) bad(`${at}: protractor only works for angles up to 180°`);
        if (w.names !== undefined && (!Array.isArray(w.names) || w.names.length !== 3 || !w.names.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 2))) bad(`${at}: names must be 3 point names of 1–2 characters each`);
        if (w.rays !== undefined) {
          if (!Array.isArray(w.rays) || w.rays.length < 1 || w.rays.length > 3) bad(`${at}: rays must have 1–3 entries`);
          else {
            for (const r of w.rays) { num(r, `${at} rays`, 1, 359); if (isNum(r) && isNum(w.degrees) && r >= w.degrees) bad(`${at}: each value in rays must be less than degrees`); }
            // 各小角至少 10°（再小标注就挤不下）：射线依次增大，相邻两条、首尾两条与边都隔开 10° 以上
            const cuts = [0, ...w.rays, w.degrees];
            if (cuts.every(isNum) && cuts.some((c, i) => i > 0 && (c as number) - (cuts[i - 1] as number) < 10)) bad(`${at}: rays must go up in order (counting from the first arm), with each smaller angle at least 10°`);
          }
          if (w.label !== undefined && w.degrees === 360) bad(`${at}: with rays, label goes outside the angle, so it cannot be used when degrees is 360 (mark the smaller angles with parts)`);
        }
        if (w.parts !== undefined) {
          if (!Array.isArray(w.parts) || w.parts.length !== (w.rays?.length ?? 0) + 1) bad(`${at}: parts must have one more entry than rays`);
          else for (const l of w.parts) if (l !== null) txt(l, `${at} parts`, 8);
        }
        break;
      case "plane": {
        num(w.width, `${at} width`, 1, 24); num(w.height, `${at} height`, 1, 16);
        oneOf(w.grid, `${at} grid`, [true, false, "dots", "iso"]);
        if (w.grid === "iso" && (w.axes || w.origin !== undefined)) bad(`${at}: axes and origin cannot be used with grid: "iso"`);
        const W = isNum(w.width) ? w.width : 24, H = isNum(w.height) ? w.height : 16;
        // 四个象限：原点在画布里的整数格点上
        if (w.origin !== undefined) {
          if (!Array.isArray(w.origin) || w.origin.length !== 2) bad(`${at}: origin must be [x, y]: how many squares the origin is from the left and from the bottom`);
          else { int(w.origin[0], `${at} origin x (squares from the left)`, 0, W); int(w.origin[1], `${at} origin y (squares from the bottom)`, 0, H); }
        }
        const R = planeRange({ width: W, height: H, origin: w.origin });
        const where = w.origin !== undefined ? `canvas (x ${R.x0} to ${R.x1}, y ${R.y0} to ${R.y1})` : `${W}×${H} canvas`;
        const pt = (p: unknown, label: string) => {
          if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) return bad(`${label} must be [x, y] (two numbers), got ${JSON.stringify(p)}`);
          if (p[0] < R.x0 - 1e-9 || p[0] > R.x1 + 1e-9 || p[1] < R.y0 - 1e-9 || p[1] > R.y1 + 1e-9) bad(`${label} ${JSON.stringify(p)} is outside the ${where}`);
        };
        const fill = (v: unknown, label: string) => oneOf(v, label, ["shade", "none", "hole"]);
        /** 等距点阵：形状的顶点、线的两端与点要落在点上（x 为整数；偶数列 y 为整数，奇数列 y 以 .5 结尾） */
        const dot = (p: unknown, label: string) => {
          if (w.grid !== "iso" || !Array.isArray(p) || !p.every(isNum)) return;
          const x = Math.round(p[0] as number), y = (p[1] as number) - (Math.abs(x) % 2) / 2;
          if (Math.abs((p[0] as number) - x) > 1e-6 || Math.abs(y - Math.round(y)) > 1e-6) bad(`${label} ${JSON.stringify(p)} is not on a dot of the iso grid (x a whole number; y a whole number in even columns, ending in .5 in odd columns)`);
        };
        const shapes = w.shapes ?? [], lines = w.lines ?? [], circles = w.circles ?? [], points = w.points ?? [];
        if (!shapes.length && !lines.length && !circles.length && !points.length && !(w.texts ?? []).length) bad(`${at}: the canvas is empty`);
        if (shapes.length > 8 || lines.length > 12 || circles.length > 4 || points.length > 16) bad(`${at}: too many items (shapes ≤ 8, lines ≤ 12, circles ≤ 4, points ≤ 16)`);
        for (const [k, s] of shapes.entries()) {
          const sat = `${at} shapes[${k}]`;
          // 正多边形按边数、中心与半径算出顶点，之后与写了 points 的形状同样校验
          if ((s.points === undefined) === (s.regular === undefined)) { bad(`${sat}: write either points or regular (a regular polygon), not both`); continue; }
          if (s.regular !== undefined) {
            const g = s.regular;
            if (!g || typeof g !== "object") { bad(`${sat}: regular must be { sides, center, r }`); continue; }
            int(g.sides, `${sat} regular.sides`, 3, 12); pt(g.center, `${sat} regular.center`); num(g.r, `${sat} regular.r`, 0.2, Math.max(W, H) / 2);
            if (g.rotate !== undefined) num(g.rotate, `${sat} regular.rotate`, -360, 360);
            if (g.spokes !== undefined && typeof g.spokes !== "boolean") bad(`${sat}: regular.spokes must be true or false`);
            if (s.open) bad(`${sat}: a regular polygon cannot be open`);
            if (!regularPoints(g)) continue;
          }
          const sp = shapePoints(s);
          // 多到 24 个顶点：要变形的圆（展开、滚动）用 24 边形近似才看着圆；大脑看到的描述对弯边多的形状只说范围
          if (!Array.isArray(s.points ?? sp) || sp.length < 2 || sp.length > 24) { bad(`${sat}: points must have 2–24 vertices`); continue; }
          if (s.regular !== undefined) { const out = sp.find((p) => { const [x, y] = p.map(Number); return x < R.x0 - 1e-3 || x > R.x1 + 1e-3 || y < R.y0 - 1e-3 || y > R.y1 + 1e-3; }); if (out) bad(`${sat}: a corner of the regular polygon (${out.map((v) => Math.round(Number(v) * 100) / 100).join(", ")}) is outside the ${where}; move the centre or make r smaller`); }
          else sp.forEach((p, j) => { pt(p, `${sat} points[${j}]`); dot(p, `${sat} points[${j}]`); });
          color(s.color, sat); fill(s.fill, `${sat} fill`);
          if (s.label !== undefined) txt(s.label, `${sat} label`, 12);
          if (s.labelAt !== undefined) pt(s.labelAt, `${sat} labelAt`);
          for (const [key, list] of [["sides", s.sides], ["angles", s.angles]] as const) {
            if (list === undefined) continue;
            if (!Array.isArray(list) || list.length > sp.length) { bad(`${sat}: ${key} can have at most ${sp.length} entries`); continue; }
            for (const l of list) if (l !== null) txt(l, `${sat} ${key}`, 12);
          }
          for (const r of s.right ?? []) if (!Number.isInteger(r) || r < 0 || r >= sp.length) bad(`${sat}: right vertex index ${r} does not exist`);
          if (s.open) {
            const last = sp.length - 1;
            if (sp.length < 3) bad(`${sat}: an open polyline needs at least 3 points`);
            if ([0, last].some((k) => (s.angles?.[k] ?? null) !== null) || (s.right ?? []).some((r) => r === 0 || r === last)) bad(`${sat}: an open polyline can only mark angles or right angles at its middle vertices`);
            if ((s.sides?.length ?? 0) > last) bad(`${sat}: too many sides for an open polyline (at most ${last})`);
          }
          if (s.names !== undefined && (!Array.isArray(s.names) || s.names.length > sp.length || !s.names.every((n) => typeof n === "string" && n.length <= 3))) bad(`${sat}: names must have at most one per vertex, each ≤ 3 characters`);
          // 平行边记号：每组 2 条以上的边（序号同 sides），一条边只进一组，同组的边要真的平行
          if (s.parallel !== undefined) {
            const count = s.open ? sp.length - 1 : sp.length, seen = new Set<number>();
            if (!Array.isArray(s.parallel) || s.parallel.length < 1 || s.parallel.length > 3) bad(`${sat}: parallel must list 1–3 groups of sides, e.g. [[0, 2], [1, 3]]`);
            else for (const group of s.parallel) {
              if (!Array.isArray(group) || group.length < 2 || group.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) { bad(`${sat}: each parallel group lists 2 or more side numbers (0–${count - 1}, side i goes from corner i to the next corner)`); continue; }
              for (const i of group) { if (seen.has(i)) bad(`${sat}: side ${i} is in more than one parallel group`); seen.add(i); }
              const dir = (i: number) => { const a = sp[i], b = sp[(i + 1) % sp.length]; return [Number(b[0]) - Number(a[0]), Number(b[1]) - Number(a[1])]; };
              const [ax, ay] = dir(group[0]);
              for (const i of group.slice(1)) {
                const [bx, by] = dir(i);
                if (Math.abs(ax * by - ay * bx) > 1e-3 * Math.hypot(ax, ay) * Math.hypot(bx, by)) bad(`${sat}: sides ${group[0]} and ${i} are marked parallel but are not parallel`);
              }
            }
          }
        }
        for (const [k, l] of lines.entries()) {
          const lat = `${at} lines[${k}]`;
          pt(l.from, `${lat} from`); pt(l.to, `${lat} to`); dot(l.from, `${lat} from`); dot(l.to, `${lat} to`);
          oneOf(l.kind, `${lat} kind`, ["plain", "segment", "ray", "line", "arrow"]);
          color(l.color, lat);
          if (l.label !== undefined) txt(l.label, `${lat} label`, 12);
        }
        for (const [k, c] of circles.entries()) {
          const cat = `${at} circles[${k}]`;
          pt(c.center, `${cat} center`); num(c.r, `${cat} r`, 0.2, Math.max(W, H) / 2);
          color(c.color, cat); fill(c.fill, `${cat} fill`);
          for (const key of ["label", "radius", "diameter"] as const) if (c[key] !== undefined) txt(c[key], `${cat} ${key}`, 12);
        }
        for (const [k, p] of points.entries()) { pt(p.at, `${at} points[${k}]`); dot(p.at, `${at} points[${k}]`); if (p.label !== undefined) txt(p.label, `${at} points[${k}] label`, 10); }
        for (const key of ["xLabel", "yLabel"] as const) if (w[key] !== undefined) txt(w[key], `${at} ${key}`, 20);
        if ((w.texts ?? []).length > 12) bad(`${at}: texts can have at most 12 entries`);
        for (const [k, t] of (w.texts ?? []).entries()) { pt(t.at, `${at} texts[${k}]`); txt(t.text, `${at} texts[${k}] text`, 16); }
        for (const key of ["xStep", "yStep"] as const) if (w[key] !== undefined) num(w[key], `${at} ${key}`, 0.001, 1e6);
        break;
      }
      case "solid": {
        oneOf(w.shape, `${at} shape`, ["cuboid", "cube", "cylinder", "cone", "sphere", "pyramid", "prism"]);
        for (const key of ["length", "width", "height", "radius", "diameter", "label", "water"] as const) if (w[key] !== undefined) txt(w[key], `${at} ${key}`, 16);
        if (w.water !== undefined && !["cuboid", "cube", "cylinder"].includes(w.shape)) bad(`${at}: water is only for cuboid, cube or cylinder`);
        oneOf(w.mark, `${at} mark`, ["faces", "edges", "vertices"]);
        // 正 n 棱柱：底面边数 3–8；四棱以上底面是正多边形，只标长与底面边长
        if (w.sides !== undefined) {
          if (w.shape !== "prism") bad(`${at}: sides is only for prism (how many sides the end faces have)`);
          else {
            int(w.sides, `${at} sides`, 3, 8);
            if (isNum(w.sides) && w.sides > 3 && w.height !== undefined) bad(`${at}: height is only for a triangular prism; a prism with ${w.sides} sides has regular ends, so write width (the side of the end face) and length`);
          }
        }
        if (w.mark !== undefined && !["cuboid", "cube", "prism", "pyramid"].includes(w.shape)) bad(`${at}: mark is only for cube, cuboid, prism or pyramid`);
        if (w.mark !== undefined && w.water !== undefined) bad(`${at}: mark cannot be used with water`);
        if (w.units !== undefined) {
          if (w.shape !== "cuboid" && w.shape !== "cube") bad(`${at}: units is only for cuboid or cube`);
          if (!Array.isArray(w.units) || w.units.length !== 3) bad(`${at}: units must be [length, width, height]`);
          else w.units.forEach((u, k) => int(u, `${at} units[${k}]`, 1, 10));
        }
        color(w.color, `${at}`);
        break;
      }
      case "cubes": {
        if (!Array.isArray(w.layout) || w.layout.length < 1 || w.layout.length > 5) { bad(`${at}: layout must have 1–5 rows`); break; }
        const cols = Array.isArray(w.layout[0]) ? w.layout[0].length : 0;
        if (cols < 1 || cols > 8 || !w.layout.every((r) => Array.isArray(r) && r.length === cols)) { bad(`${at}: layout rows must all be the same length (1–8 columns)`); break; }
        let total = 0;
        for (const r of w.layout) for (const h of r) { int(h, `${at} stack height`, 0, 5); total += isNum(h) ? h : 0; }
        if (total < 1) bad(`${at}: needs at least one cube`);
        color(w.color, `${at}`);
        break;
      }
      case "ruler": {
        int(w.length, `${at} length`, 1, 30);
        if (w.start !== undefined) int(w.start, `${at} start`, 0, 10000);
        oneOf(w.unit, `${at} unit`, ["cm", "m", "in", "ft"]);
        // 每个单位分几小格：公制十进，英寸对半再对半，英尺可分成 12 英寸
        oneOf(w.minor, `${at} minor (for ${w.unit ?? "cm"})`, w.unit === "in" ? [0, 2, 4, 8] : w.unit === "ft" ? [0, 2, 4, 12] : [0, 2, 4, 5, 10]);
        const len = isNum(w.length) ? w.length : 30, s0 = isNum(w.start) ? w.start : 0;
        if (isNum(w.minor) && len * w.minor > 300) bad(`${at}: ${len} × ${w.minor} small marks are too many for the board (at most 300)`);
        if ((w.items ?? []).length > 3) bad(`${at}: items can have at most 3 entries`);
        for (const it of w.items ?? []) {
          num(it.from, `${at} from`, s0, s0 + len); num(it.to, `${at} to`, s0, s0 + len); places3(it.from, `${at} from`); places3(it.to, `${at} to`);
          if (isNum(it.from) && isNum(it.to) && it.to <= it.from) bad(`${at}: to must be greater than from`);
          if (it.label !== undefined) txt(it.label, `${at} label`, 14);
          if (it.icon !== undefined) icon(it.icon, `${at} icon`);
          color(it.color, `${at}`);
        }
        break;
      }
      case "gauge": {
        oneOf(w.kind, `${at} kind`, ["scale", "jug", "thermometer"]);
        const min = w.min ?? 0;
        num(min, `${at} min`, -100, 1e5); num(w.max, `${at} max`, -100, 1e5); num(w.step, `${at} step`, 0.001, 1e5); num(w.value, `${at} value`, -100, 1e5);
        if (isNum(min) && isNum(w.max) && isNum(w.step) && w.step > 0) {
          const ticks = (w.max - min) / w.step;
          if (w.max <= min) bad(`${at}: max must be greater than min`);
          else if (ticks > 50 + 1e-9 || Math.abs(ticks - Math.round(ticks)) > 1e-6) bad(`${at}: the scale from ${min} to ${w.max} in steps of ${w.step} must have a whole number of intervals, at most 50`);
          if (isNum(w.value) && (w.value < min || w.value > w.max)) bad(`${at}: value ${w.value} is outside the scale ${min}–${w.max}`);
        }
        if (w.kind !== "thermometer" && isNum(min) && min < 0) bad(`${at}: only a thermometer can have a negative scale`);
        txt(w.unit, `${at} unit`, 8);
        if (w.labelEvery !== undefined) int(w.labelEvery, `${at} labelEvery`, 1, 50);
        if (w.label !== undefined) txt(w.label, `${at} label`, 16);
        break;
      }
      case "calendar": {
        int(w.year, `${at} year`, 1900, 2100); int(w.month, `${at} month`, 1, 12);
        const days = isNum(w.year) && isNum(w.month) ? daysInMonth(w.year, w.month) : 31;
        for (const d of [...(w.highlight ?? []), ...(w.missing ?? [])]) int(d, `${at} day`, 1, days);
        break;
      }
      case "timeline": {
        const from = parseTime(w.from), to = parseTime(w.to);
        if (from === null) bad(`${at}: from must be a time like "8:30", got ${JSON.stringify(w.from)}`);
        if (to === null) bad(`${at}: to must be a time like "8:30", got ${JSON.stringify(w.to)}`);
        num(w.step ?? 30, `${at} step`, 1, 240);
        oneOf(w.format, `${at} format`, ["12h", "24h"]);
        if (from !== null && to !== null) {
          const step = isNum(w.step) ? w.step : 30;
          // to 早于 from：跨过午夜到第二天
          const end = to > from ? to : to + 1440, day = (t: number) => (t < from ? t + 1440 : t);
          if (to === from) bad(`${at}: to cannot equal from`);
          else if ((end - from) / step > 30 || (end - from) % step) bad(`${at}: the timeline from ${w.from} to ${w.to} in ${step}-minute steps must have a whole number of intervals, at most 30`);
          const inside = (v: unknown, label: string) => {
            const t = parseTime(v);
            if (t === null) bad(`${label} must be a time like "8:30", got ${JSON.stringify(v)}`);
            else if (day(t) < from || day(t) > end) bad(`${label} ${JSON.stringify(v)} is not on the timeline ${w.from}–${w.to}`);
          };
          for (const m of w.marks ?? []) {
            if (m && typeof m === "object") { inside(m.at, `${at} marks.at`); if (m.label !== undefined) txt(m.label, `${at} marks.label`, 14); }
            else inside(m, `${at} marks`);
          }
          for (const j of w.jumps ?? []) { inside(j.from, `${at} jumps.from`); inside(j.to, `${at} jumps.to`); if (j.label !== undefined) txt(j.label, `${at} jumps.label`, 14); }
        }
        break;
      }
      case "venn": {
        txt(w.left, `${at} left`, 16); txt(w.right, `${at} right`, 16);
        for (const key of ["leftOnly", "both", "rightOnly", "neither", "leftTotal", "rightTotal"] as const) {
          const v = w[key];
          if (v === undefined && key !== "leftOnly" && key !== "both" && key !== "rightOnly") continue;
          if (isNum(v)) num(v, `${at} ${key}`, 0, 1e6);
          else txt(v, `${at} ${key}`, 20);
        }
        if (w.total !== undefined) txt(w.total, `${at} total`, 20);
        break;
      }
      case "areaModel": {
        if (!Array.isArray(w.cols) || w.cols.length < 1 || w.cols.length > 4) { bad(`${at}: cols must have 1–4 entries`); break; }
        if (!Array.isArray(w.rows) || w.rows.length < 1 || w.rows.length > 3) { bad(`${at}: rows must have 1–3 entries`); break; }
        for (const v of [...w.cols, ...w.rows]) { num(v, `${at} side length`, 0.01, 100_000, true); places3(v, `${at} side length`); }
        if (w.cells !== undefined) {
          if (!Array.isArray(w.cells) || w.cells.length !== w.rows.length || !w.cells.every((r) => Array.isArray(r) && r.length === w.cols.length)) bad(`${at}: cells must be ${w.rows.length} × ${w.cols.length} (rows × columns)`);
          else for (const r of w.cells) for (const c of r) if (c !== null) { if (isNum(c)) places3(c, `${at} cells`); else txt(c, `${at} cells`, 10); }
        }
        if (w.unit !== undefined && !["mm", "cm", "m", "km"].includes(w.unit)) bad(`${at}: unit must be one of mm, cm, m, km (cells show square units automatically)`);
        break;
      }
      case "suanpan": {
        // 数（0–99,999 的整数）、"?"（整个数待求），或含 ? 的数字串（那几档待求，如 "3?5"）
        let digits = 1;
        if (typeof w.number === "string" && w.number !== "?") {
          if (!/^[\d?]{1,5}$/.test(w.number) || !w.number.includes("?")) bad(`${at}: number must be a whole number 0–99,999, "?" or digits with ? for the hidden rods (e.g. "3?5"), got ${JSON.stringify(w.number)}`);
          digits = w.number.length;
        } else if (w.number !== "?") {
          int(w.number, `${at} number`, 0, 99_999);
          if (isNum(w.number)) digits = String(Math.round(w.number)).length;
        }
        if (w.rods !== undefined) {
          int(w.rods, `${at} rods`, 1, 6);
          if (isNum(w.rods) && w.rods < digits) bad(`${at}: ${w.rods} rods are not enough for ${digits} digits`);
        }
        if (w.labels !== undefined && typeof w.labels !== "boolean") bad(`${at}: labels must be true or false`);
        break;
      }
      case "fingers":
        if (!Array.isArray(w.hands) || w.hands.length < 1 || w.hands.length > 4) { bad(`${at}: hands must have 1–4 entries`); break; }
        for (const h of w.hands) int(h, `${at} fingers`, 0, 5);
        break;
      case "dice": {
        if (!Array.isArray(w.faces) || w.faces.length < 1 || w.faces.length > 6) { bad(`${at}: faces must have 1–6 entries`); break; }
        for (const f of w.faces) if (f !== "?") num(f, `${at} face`, 1, w.card ? 10 : 6);
        if (w.card !== undefined && typeof w.card !== "boolean") bad(`${at}: card must be true or false`);
        for (const h of w.highlight ?? []) if (!Number.isInteger(h) || h < 1 || h > w.faces.length) bad(`${at}: highlight ${h} is not one of the faces (counting from 1)`);
        break;
      }
      case "coins": {
        if (!Array.isArray(w.faces) || w.faces.length < 1 || w.faces.length > 10) { bad(`${at}: faces must have 1–10 entries`); break; }
        for (const f of w.faces) if (!["H", "T", "?"].includes(f)) bad(`${at}: each face must be "H" (heads), "T" (tails) or "?", got ${JSON.stringify(f)}`);
        for (const h of w.highlight ?? []) if (!Number.isInteger(h) || h < 1 || h > w.faces.length) bad(`${at}: highlight ${h} is not one of the coins (counting from 1)`);
        break;
      }
      case "tally": {
        if (!Array.isArray(w.rows) || w.rows.length < 1 || w.rows.length > 6) { bad(`${at}: rows must have 1–6 entries`); break; }
        for (const r of w.rows) { txt(r?.label, `${at} label`, 16); int(r?.count, `${at} count`, 0, 40); }
        if (w.title !== undefined) txt(w.title, `${at} title`, 40);
        if (w.totals !== undefined && typeof w.totals !== "boolean") bad(`${at}: totals must be true or false`);
        if (w.plain !== undefined && typeof w.plain !== "boolean") bad(`${at}: plain must be true or false`);
        if (w.hide !== undefined) {
          if (!w.totals) bad(`${at}: hide needs totals (it shows ? in the Total column)`);
          for (const h of Array.isArray(w.hide) ? w.hide : [NaN]) if (!Number.isInteger(h) || h < 0 || h >= w.rows.length) bad(`${at}: hide position ${h} is not one of the rows (counting from 0)`);
        }
        break;
      }
      case "flow": {
        if (!Array.isArray(w.steps) || w.steps.length < 2 || w.steps.length > 7) { bad(`${at}: steps must have 2–7 entries`); break; }
        const last = w.steps.length - 1;
        for (const [k, s] of w.steps.entries()) {
          const sat = `${at} steps[${k}]`;
          if (typeof s?.text !== "string" || !s.text.trim() || s.text.length > 40) bad(`${sat}: text must be 1–40 characters`);
          oneOf(s?.kind, `${sat} kind`, ["start", "step", "question", "end"]);
          for (const key of ["yes", "no"] as const) {
            const v = s?.[key];
            if (v === undefined) continue;
            if (s.kind !== "question") bad(`${sat}: ${key} is only for a question`);
            else if (!Number.isInteger(v) || v < 0 || v > last || v === k) bad(`${sat}: ${key} must point to another step (0–${last}, counting from 0), got ${JSON.stringify(v)}`);
          }
          if (s?.next !== undefined) {
            if (s.kind === "question" || s.kind === "end") bad(`${sat}: next is only for start and step boxes (a question uses yes and no; an end box stops)`);
            else if (!Number.isInteger(s.next) || s.next < 0 || s.next > last || s.next === k) bad(`${sat}: next must point to another step (0–${last}, counting from 0), got ${JSON.stringify(s.next)}`);
          }
          if (s?.kind === "question") {
            if ((s.yes ?? k + 1) === s.no) bad(`${sat}: yes and no cannot lead to the same step`);
            if (s.yes === undefined && k === last) bad(`${sat}: the last step cannot be a question unless yes points to another step`);
          }
        }
        break;
      }
      case "boxPlot": {
        num(w.from, `${at} from`, -1e6, 1e6); num(w.to, `${at} to`, -1e6, 1e6);
        if (w.step !== undefined) num(w.step, `${at} step`, 0.001, 1e6);
        const lo = isNum(w.from) ? w.from : -Infinity, hi = isNum(w.to) ? w.to : Infinity;
        if (isNum(w.from) && isNum(w.to)) {
          if (w.to <= w.from) bad(`${at}: to must be greater than from`);
          else {
            const step = boxStep(w);
            if (step === null) bad(`${at}: write a step that splits ${w.from}–${w.to} into a whole number of intervals`);
            else {
              const ticks = (w.to - w.from) / step;
              if (ticks > 30 + 1e-9) bad(`${at}: more than 30 intervals, too many for the board (use a larger step)`);
              else if (Math.abs(ticks - Math.round(ticks)) > 1e-6) bad(`${at}: the range from–to must be a whole number of intervals (a multiple of step)`);
            }
          }
        }
        if (w.labelEvery !== undefined) int(w.labelEvery, `${at} labelEvery`, 1, 30);
        if (w.unit !== undefined) txt(w.unit, `${at} unit`, 16);
        if (w.title !== undefined) txt(w.title, `${at} title`, 40);
        if (w.showValues !== undefined && typeof w.showValues !== "boolean") bad(`${at}: showValues must be true or false`);
        if (!Array.isArray(w.plots) || w.plots.length < 1 || w.plots.length > 2) { bad(`${at}: plots must have 1–2 entries (one box plot, or two to compare)`); break; }
        for (const [k, p] of w.plots.entries()) {
          const pat = `${at} plots[${k}]`;
          for (const key of BOX_KEYS) { num(p?.[key], `${pat} ${key}`, lo, hi); places3(p?.[key], `${pat} ${key}`); }
          const vals = BOX_KEYS.map((key) => p?.[key]);
          if (vals.every(isNum) && vals.some((v, i) => i > 0 && v < vals[i - 1] - 1e-9)) bad(`${pat}: the five numbers must go up in order: min ≤ q1 ≤ median ≤ q3 ≤ max`);
          if (p?.label !== undefined) txt(p.label, `${pat} label`, 16);
          color(p?.color, pat);
          if (p?.hide !== undefined && (!Array.isArray(p.hide) || p.hide.some((h) => !BOX_KEYS.includes(h)))) bad(`${pat}: hide can list ${BOX_KEYS.join(", ")}`);
        }
        break;
      }
      case "text": if (typeof w.text !== "string" || !w.text.trim() || w.text.length > 60) bad(`${at}: text must be 1–60 characters`); break;
      default: bad(`${at} is not a known diagram type (available: ${WIDGET_TYPES.join(", ")})`);
    }
  }
  return errs;
}
