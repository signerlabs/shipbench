# S5 · Link previews must not touch private addresses (feature)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Swift

**Starting code (`base/`):** the link-preview module of a shipping macOS clipboard manager, extracted into a local Swift package `LinkPreviews` (copied links show a page title, site icon and cover image, fetched straight from the user's Mac with LinkPresentation and cached locally), with 5 offline tests. The address check was reduced to "http(s) with a host"; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** copying a router admin address, a printer's `.local` address, an intranet `.corp` wiki or a link with a username and password makes the app fetch a preview from it. Only public http(s) domain names may be fetched: no IPv4/IPv6 addresses, `localhost` or single-label hosts, `.local`, `.localhost`, `.lan`, `.internal`, `.corp`, `.home.arpa` (any case), or URLs with credentials; normal public URLs (ports, upper case) still work. Add tests; `swift test` must pass.

**Grading (`runner/grade_s5.py`):** 6 hidden tests from `hidden/`: 5 scored cases (IPv4, IPv6, localhost and single-label hosts, private suffixes, credentials) and 1 guard (public domains still accepted). Score = scored cases passed / 5 × 100, halved if the guard or any other test fails or any of the 5 original tests is missing.

---

**中文：** 题面写现象：复制路由器地址、.local、.corp、带账号密码的链接，App 都会去抓预览；只许取公网的 http(s) 域名。底稿是一个已上线 Mac 剪贴板 App 的链接预览模块（拆成 Swift 包），把地址判断退成只看协议和主机名。判分：5 个目标用例过几个算几分，1 个守门用例（公网域名照常能取）和其余测试有挂、或原有 5 条测试少了，分数减半。
