这是一个 Mac 剪贴板 App 的链接预览模块（Swift 包 LinkPreviews）：复制过的链接在历史卡片上显示网页标题、站点图标和封面图，用系统的 LinkPresentation 从用户的 Mac 直接访问那个网站去取，取到的存在本机缓存里。

用户反馈：复制了路由器后台地址（比如 http://192.168.1.1）、打印机的 .local 地址、公司 .corp 的内网 wiki，还有带账号密码的链接（https://user:pass@…），App 都会去访问那个地址抓预览。在公司里这会去碰内网服务，带账号密码的链接还会把账号发出去。

要求：

1. 链接预览只去取公网的 http(s) 域名。下面这些一律不取：IP 地址（IPv4 和 IPv6）；localhost 和没有点的单段主机名（比如 http://router/）；内网后缀 .local、.localhost、.lan、.internal、.corp、.home.arpa（不分大小写）；带账号或密码的链接。正常的公网网址照常取（带端口、有大写字母的都算正常）。
2. 补上测试。全部测试都要通过：`swift test`。
3. 不改公开接口，不删已有的测试。
