#!/bin/bash
# 坦克大战启动器：双击本文件即可开始游戏
# （游戏用了 ES 模块，浏览器不允许用 file:// 直接打开，必须走本地 http 服务）

cd "$(dirname "$0")" || exit 1
PORT=5173

if lsof -i :"$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 已经在跑了，直接打开页面。"
  echo "（如果刚换了音乐文件，请先关掉那个旧窗口再运行本文件，否则它还在用旧的 MIME 设置）"
else
  echo "正在启动本地服务（只监听本机，不占用局域网端口）…"
  # 不用 python3 -m http.server：它按系统表猜 MIME，macOS 上会把 .flac 猜成 audio/x-flac，
  # Safari 对不上就不放音乐。这里手动补上音频类型，三个浏览器就都稳了。
  python3 -c "
import http.server, mimetypes
mimetypes.add_type('audio/flac', '.flac')
mimetypes.add_type('audio/ogg', '.ogg')
mimetypes.add_type('audio/ogg', '.opus')
mimetypes.add_type('audio/mpeg', '.mp3')
srv = http.server.ThreadingHTTPServer(('127.0.0.1', $PORT), http.server.SimpleHTTPRequestHandler)
srv.serve_forever()
" >/dev/null 2>&1 &
  sleep 1
fi

open "http://127.0.0.1:$PORT/"
echo ""
echo "坦克大战已启动： http://127.0.0.1:$PORT/"
echo "玩完直接关掉这个窗口就行。"
echo ""

wait
