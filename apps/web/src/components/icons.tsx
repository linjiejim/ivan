/**
 * 图标（设计系统）：全站只用 Phosphor 一个家族、regular 一种字重，默认 16px（见 main.tsx 的 IconContext）。
 * 按「概念」起名而不是按图形起名：同一个概念在任何页面都是同一个图形，换图标只改这一个文件。
 * 纯装饰的图标会被 Phosphor 标成 aria-hidden；只有图标没有文字的按钮，必须在按钮上写 aria-label。
 */
export {
  // 导航与实体
  SquaresFourIcon as IconBoard, // 看板
  FunnelIcon as IconStrategy, // 策略（选股策略本质是一个漏斗：筛选 + 排序）
  FlaskIcon as IconBacktest, // 回测（一次回测、回测记录）
  PulseIcon as IconTracking, // 跟踪（上线后的模拟盘）
  NewspaperIcon as IconBrief, // 今日简报
  ChartLineIcon as IconChart, // 净值、走势
  CalendarCheckIcon as IconPlan, // 明日计划
  BriefcaseIcon as IconPositions, // 持仓
  ListChecksIcon as IconRules, // 规则
  ClockCounterClockwiseIcon as IconHistory, // 版本、历史对话
  ListDashesIcon as IconTrace, // 决策回溯（时间线）
  ListMagnifyingGlassIcon as IconScreen, // 按策略选股（今日选股）
  FileMagnifyingGlassIcon as IconEvidence, // 个股证据（某个决策日为什么选它）
  UsersThreeIcon as IconChips, // 筹码：两融与筹码（融资余额、股东户数、解禁、大宗交易）
  GlobeHemisphereEastIcon as IconMarket, // 大盘与市场宽度
  FactoryIcon as IconIndustry, // 行业
  ScalesIcon as IconValuation, // 估值与因子的历史位置
  ReceiptIcon as IconFinancials, // 财报与分红
  CalculatorIcon as IconCalc, // 计算器
  EyeIcon as IconOverview, // 概览
  ClipboardTextIcon as IconSignals, // 信号集
  BookOpenTextIcon as IconTemplate, // 模板
  SlidersHorizontalIcon as IconSweep, // 参数扫描
  ShieldCheckIcon as IconChecks, // 诚实检查
  DatabaseIcon as IconData, // 数据
  TicketIcon as IconInvite, // 邀请码
  EnvelopeSimpleIcon as IconMail, // 试用申请（留邮箱要邀请码）
  UsersIcon as IconUsers, // 用户
  GaugeIcon as IconUsage, // 用量
  GearSixIcon as IconAdmin, // 管理
  // 动作
  SparkleIcon as IconAI, // 一切 AI 入口：问 AI、AI 解读、对话新建
  PlayIcon as IconRun, // 开始回测
  BroadcastIcon as IconGoLive, // 上线跟踪
  StopCircleIcon as IconStop, // 停止跟踪
  StopIcon as IconStopGenerating, // 停止生成
  NotePencilIcon as IconCompose, // 新对话
  PencilSimpleIcon as IconEdit,
  PlusIcon as IconAdd,
  TrashIcon as IconDelete,
  ArrowsLeftRightIcon as IconCompare,
  ArrowsClockwiseIcon as IconRefresh,
  UploadSimpleIcon as IconImport,
  CopyIcon as IconCopy,
  SealCheckIcon as IconVerify, // 复核数据（只比输入指纹）
  FingerprintSimpleIcon as IconChain, // 账本链校验（每条带上一条的指纹）
  ArrowCounterClockwiseIcon as IconReproduce, // 完整重跑
  DownloadSimpleIcon as IconDownload,
  LinkSimpleIcon as IconLink,
  KeyIcon as IconKey,
  ArrowUpIcon as IconSend,
  SignOutIcon as IconSignOut,
  SelectionIcon as IconBrush, // 图上框选一段
  EyeIcon as IconShow, // 显示密码
  EyeSlashIcon as IconHide, // 隐藏密码
  PaperclipIcon as IconContext, // 对话带上的页面上下文
  // 状态
  InfoIcon as IconInfo,
  WarningIcon as IconWarn,
  WarningCircleIcon as IconError,
  CheckIcon as IconCheck,
  CheckCircleIcon as IconSuccess,
  CircleNotchIcon as IconSpinner,
  PlugsIcon as IconOffline, // 行情服务没在跑
  ClockIcon as IconClock, // 数据截至
  // 主题
  SunIcon as IconLight,
  MoonIcon as IconDark,
  DesktopIcon as IconSystem,
  // 方向
  CaretRightIcon as IconChevronRight,
  CaretLeftIcon as IconChevronLeft,
  CaretDownIcon as IconChevronDown,
  CaretUpDownIcon as IconSelect,
  ArrowRightIcon as IconArrowRight,
  XIcon as IconClose,
} from "@phosphor-icons/react";
export type { Icon } from "@phosphor-icons/react";
